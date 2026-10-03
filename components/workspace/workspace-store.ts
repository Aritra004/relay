import {
  initialItems,
  initialWorkspace,
  stages as initialStages,
  type ItemChanges,
  type StageId,
  type WorkItem,
  type WorkspaceData,
  type WorkspaceDetails,
} from "./workspace-data.ts";
import { initialPresenceState, EDITING_TTL_MS, type PresenceState } from "../../lib/presence-contract.ts";
import type { ItemMove } from "./item-movement.ts";
import type { Operation, UpdateItemPayload } from "./workspace-operations.ts";
import { applyWorkspaceOperation } from "./apply-workspace-operation.ts";
import {
  workspaceRepository,
  type WorkspaceRepository,
  type WorkspaceSyncMetadata,
  type SavedWorkspace,
} from "../../lib/workspace-repository.ts";
import { describeStorageError } from "../../lib/local-storage-errors.ts";
import type {
  OperationAcknowledgment,
  OperationFailure,
} from "../../lib/operation-contract.ts";
import {
  transitionSyncPhase,
  type SyncPhase,
  type RemoteOperation,
} from "../../lib/sync-contract.ts";
import { applyOperationData } from "./apply-workspace-operation.ts";
import { canReplay } from "../../lib/sync-replay.ts";
import {
  operationBlocked,
  type ConflictContext,
} from "../../lib/conflict-contract.ts";
import { initialRealtimeState, type RealtimeState } from "../../lib/realtime-contract.ts";

export interface WorkspaceState extends WorkspaceData {
  readonly workspace: WorkspaceDetails;
  readonly selectedItemId: string | null;
  // Browser connectivity alone never implies acknowledgment.
  readonly syncStatus: "local" | "offline";
  readonly syncPhase: SyncPhase;
  readonly syncRequest: number;
  readonly realtime: RealtimeState;
  readonly presence: PresenceState;
  readonly editingEntityId: string | null;
  readonly remoteChanges: Readonly<Record<string, { operationId: string; timestamp: number; type: Operation["type"] }>>;
  // Applied locally, awaiting acknowledgment. The count is this list's length.
  readonly pendingOperations: readonly Operation[];
  // The most recent applied change, for inspection.
  readonly lastOperation: Operation | null;
  readonly restoration: "loading" | "ready" | "error";
  readonly syncMetadata: WorkspaceSyncMetadata;
  readonly persistedLocalRevision: number;
  readonly unsavedOperationCount: number;
  readonly storageError: string | null;
  readonly isResetting: boolean;
  readonly editingBlocked: boolean;
  readonly uploadingOperationId: string | null;
  readonly uploadedCount: number;
}

export interface ItemFilters {
  readonly query?: string;
  readonly onlyMine?: boolean;
  readonly category?: WorkItem["label"] | "All categories";
}

export type ItemMoveDirection = "up" | "down" | "left" | "right";

export type MoveItemInput =
  | Readonly<ItemMove>
  | {
      readonly itemId: string;
      readonly direction: ItemMoveDirection;
      readonly filters?: ItemFilters;
    };

// The complete set of supported domain mutations. No generic setter or patch API.
// Each action publishes its optimistic local state before returning. Return values
// describe the local commit, never a server acknowledgement.
export type WorkspaceActions = Readonly<{
  createItem: (
    title: string,
    stageId: StageId,
  ) => Readonly<WorkItem> | undefined;
  updateItem: (itemId: string, changes: ItemChanges) => boolean;
  deleteItem: (itemId: string) => boolean;
  moveItem: (move: MoveItemInput) => boolean;
  renameStage: (stageId: StageId, name: string, baseVersion?: number | null) => boolean;
}>;

// Readonly types protect TS consumers; freezing also protects returned entities
// and snapshots at runtime. Shared, already-frozen branches are skipped.
function freezeSnapshot<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}

function matchesFilters(item: Readonly<WorkItem>, filters: ItemFilters) {
  return (
    (!filters.onlyMine || item.assignee === "You") &&
    (!filters.category ||
      filters.category === "All categories" ||
      filters.category === item.label) &&
    `${item.id} ${item.title} ${item.description}`
      .toLowerCase()
      .includes(filters.query?.trim().toLowerCase() ?? "")
  );
}

// The whole board can be reconstructed from a snapshot. Filters only affect its
// presentation; membership and position always come from the stored ID orders.
// This grouped view is derived for rendering and is never stored on the stages.
export function selectBoard(state: WorkspaceState, filters: ItemFilters = {}) {
  return state.stageOrder.map((stageId) => ({
    stage: state.stages[stageId],
    items: state.itemOrderByStage[stageId]
      .map((id) => state.items[id])
      .filter((item) => matchesFilters(item, filters)),
    totalItems: state.itemOrderByStage[stageId].length,
  }));
}

export function selectStages(state: WorkspaceState) {
  return state.stageOrder.map((id) => state.stages[id]);
}

export function selectItems(state: WorkspaceState) {
  return state.stageOrder.flatMap((stageId) =>
    state.itemOrderByStage[stageId].map((id) => state.items[id]),
  );
}

export function selectSelectedItem(state: WorkspaceState) {
  return state.selectedItemId === null
    ? undefined
    : state.items[state.selectedItemId];
}

// Create once at the application boundary, never inside a column or card.
// A factory also keeps server requests and isolated tests from sharing state.
export function createWorkspaceStore({
  workspace = initialWorkspace,
  items = initialItems,
  repository = workspaceRepository,
  savedWorkspace,
}: {
  workspace?: WorkspaceDetails;
  items?: readonly WorkItem[];
  // null is an explicitly ephemeral store for isolated domain tests/previews.
  repository?: WorkspaceRepository | null;
  savedWorkspace?: SavedWorkspace;
} = {}) {
  workspace = savedWorkspace?.workspace ?? workspace;
  const initialState = freezeSnapshot<WorkspaceState>({
    workspace: { ...workspace, members: [...workspace.members] },
    stages: Object.fromEntries(
      initialStages.map((stage) => [stage.id, { ...stage }]),
    ) as WorkspaceState["stages"],
    items: Object.fromEntries(items.map((item) => [item.id, { ...item }])),
    stageOrder: initialStages.map((stage) => stage.id),
    itemOrderByStage: Object.fromEntries(
      initialStages.map((stage) => [
        stage.id,
        items
          .filter((item) => item.stageId === stage.id)
          .map((item) => item.id),
      ]),
    ) as Record<StageId, string[]>,
    ...(savedWorkspace
      ? {
          stages: savedWorkspace.stages,
          items: savedWorkspace.items,
          stageOrder: savedWorkspace.stageOrder,
          itemOrderByStage: savedWorkspace.itemOrderByStage,
        }
      : {}),
    selectedItemId: null,
    syncStatus: "local",
    syncPhase: "idle",
    syncRequest: 0,
    realtime: initialRealtimeState,
    presence: initialPresenceState,
    editingEntityId: null,
    remoteChanges: {},
    pendingOperations: savedWorkspace?.pendingOperations ?? [],
    lastOperation: null,
    restoration: repository ? "loading" : "ready",
    syncMetadata: {
      workspaceId: workspace.id,
      localRevision: 0,
      lastServerVersion: null,
      lastSyncedAt: null,
    },
    persistedLocalRevision: 0,
    unsavedOperationCount: 0,
    storageError: null,
    isResetting: false,
    editingBlocked: false,
    uploadingOperationId: null,
    uploadedCount: 0,
  });
  let state = initialState;
  const listeners = new Set<() => void>();
  const writes: {
    previous: WorkspaceState;
    snapshot: WorkspaceState;
    operation: Operation;
    expectedRevision: number;
  }[] = [];
  let restoring: Promise<void> | undefined;
  let writing: Promise<void> | undefined;
  let writeError: unknown;
  let resetting: Promise<void> | undefined;
  let syncWriting: Promise<SavedWorkspace> | undefined;

  function initialize(): Promise<void> {
    if (resetting) return resetting;
    if (state.restoration === "ready" || !repository) return Promise.resolve();
    if (restoring) return restoring;
    publish({ ...state, restoration: "loading", storageError: null });
    restoring = repository
      .restoreOrSeed(initialState)
      .then((saved) => {
        if (!saved.syncMetadata) throw new Error("Missing workspace metadata.");
        publish({
          ...state,
          ...saved,
          syncMetadata: saved.syncMetadata,
          syncPhase:
            state.syncStatus === "offline"
              ? "offline"
              : saved.syncMetadata.syncConflict
                ? "conflict"
                : saved.syncMetadata.uploadFailure
                  ? "error"
                  : "idle",
          persistedLocalRevision: saved.syncMetadata.localRevision,
          lastOperation: saved.pendingOperations.at(-1) ?? null,
          restoration: "ready",
          storageError: null,
        });
      })
      .catch((error: unknown) => {
        publish({
          ...state,
          restoration: "error",
          storageError: describeStorageError(error),
        });
        throw error;
      })
      .finally(() => {
        restoring = undefined;
      });
    return restoring;
  }

  function drainWrites(): Promise<void> {
    if (writing) return writing;
    if (!repository || writeError || state.isResetting || state.storageError)
      return Promise.resolve();
    writing = (async () => {
      if (syncWriting) await syncWriting;
      while (writes.length > 0 && !state.isResetting) {
        const write = writes[0];
        try {
          const committed = await repository.commitMutation(
            write.snapshot,
            write.operation,
            write.expectedRevision,
            write.previous,
          );
          writes.shift();
          if (committed) publishSaved(committed);
          publish({
            ...state,
            persistedLocalRevision: write.snapshot.syncMetadata.localRevision,
            unsavedOperationCount: writes.length,
            storageError: null,
          });
        } catch (error) {
          writeError = error;
          publish({ ...state, storageError: describeStorageError(error) });
          break;
        }
      }
    })().finally(() => {
      writing = undefined;
      // A caller can enqueue a new edit while an empty flush is settling.
      if (
        writes.length > 0 &&
        !writeError &&
        !state.isResetting &&
        !state.storageError
      )
        void drainWrites();
    });
    return writing;
  }

  async function flush() {
    if (resetting) return resetting;
    await drainWrites();
    if (writeError) throw writeError;
    if (state.storageError) throw new Error(state.storageError);
  }

  function resetWorkspace(online: boolean): Promise<void> {
    if (process.env.NODE_ENV !== "development") {
      return Promise.reject(
        new Error("Local database reset is available only in development."),
      );
    }
    if (resetting) return resetting;
    if (!repository) {
      publish({ ...initialState, syncStatus: online ? "local" : "offline" });
      return Promise.resolve();
    }
    publish({
      ...state,
      isResetting: true,
      syncStatus: online ? "local" : "offline",
    });
    resetting = (async () => {
      try {
        // Let the active transaction settle. Queued writes stay in memory until
        // the reset commits, so a failed reset cannot silently discard them.
        await restoring?.catch(() => {});
        await writing;
        if (!repository.development)
          throw new Error("Development reset is unavailable.");
        const saved =
          await repository.development.resetLocalDatabase(initialState);
        if (!saved.syncMetadata) throw new Error("Missing reset metadata.");
        writes.length = 0;
        writeError = undefined;
        publish({
          ...initialState,
          ...saved,
          syncMetadata: saved.syncMetadata,
          syncStatus: state.syncStatus,
          restoration: "ready",
          isResetting: false,
        });
      } catch (error) {
        publish({
          ...state,
          isResetting: false,
          storageError: `Reset failed. ${describeStorageError(error)}`,
        });
        throw error;
      }
    })().finally(() => {
      resetting = undefined;
    });
    return resetting;
  }

  function publish(next: WorkspaceState) {
    if (next === state) return;
    state = freezeSnapshot(next);
    // Notify React in this call stack so every consumer sees the local result.
    listeners.forEach((listener) => listener());
  }

  function operationMetadata(entityId: string) {
    return {
      id: crypto.randomUUID(),
      workspaceId: state.workspace.id,
      entityId,
      timestamp: new Date().toISOString(),
    };
  }

  function commitOperation(operation: Operation): boolean {
    if (
      state.restoration !== "ready" ||
      state.storageError ||
      state.isResetting ||
      state.editingBlocked ||
      operationBlocked(operation, state.syncMetadata.conflicts ?? [])
    )
      return false;
    const next = applyWorkspaceOperation(state, operation);
    if (next === state) return false;
    const snapshot: WorkspaceState = {
      ...next,
      syncPhase: state.syncPhase === "synced" ? "idle" : state.syncPhase,
      syncMetadata: {
        ...state.syncMetadata,
        localRevision: state.syncMetadata.localRevision + 1,
      },
      persistedLocalRevision: repository
        ? state.persistedLocalRevision
        : state.syncMetadata.localRevision + 1,
      unsavedOperationCount: repository ? writes.length + 1 : 0,
    };
    if (repository)
      writes.push({
        previous: state,
        snapshot,
        operation,
        expectedRevision: state.syncMetadata.localRevision,
      });
    // The edit is immediately visible, but remains explicitly unsaved until the
    // entity, ordering, queue entry, and revision transaction has completed.
    publish(snapshot);
    void drainWrites();
    return true;
  }

  const actions: WorkspaceActions = Object.freeze({
    renameStage(stageId: StageId, name: string, baseVersion?: number | null) {
      const trimmed = name.trim();
      if (!Object.hasOwn(state.stages, stageId) || !trimmed || trimmed.length > 80) return false;
      return commitOperation({
        ...operationMetadata(stageId),
        entityId: stageId,
        type: "RENAME_STAGE",
        payload: { name: trimmed },
        baseVersion: baseVersion === undefined ? state.stages[stageId].version ?? null : baseVersion,
      });
    },
    createItem(title: string, stageId: StageId) {
      const trimmed = title.trim();
      if (!trimmed || trimmed.length > 300 || !Object.hasOwn(state.stages, stageId)) return undefined;
      // The entity keeps this ID; the operation gets its own independent ID.
      const itemId = crypto.randomUUID();
      const applied = commitOperation({
        ...operationMetadata(itemId),
        type: "CREATE_ITEM",
        payload: {
          title: trimmed,
          description: "",
          stageId,
          assignee: "You",
          label: "Product",
          version: 1,
        },
        baseVersion: null,
      });
      return applied ? state.items[itemId] : undefined;
    },
    updateItem(itemId: string, changes: ItemChanges) {
      if (!Object.hasOwn(state.items, itemId)) return false;
      const item = state.items[itemId];
      const title = changes.title ?? item.title;
      const description = changes.description ?? item.description;
      if (state.workspace.source === "server" && (!title.trim() || title.length > 300 || description.length > 20_000)) return false;
      if (title === item.title && description === item.description)
        return false;
      // Describe only changed, editable fields, never a replacement item record.
      const payload: UpdateItemPayload =
        title !== item.title
          ? {
              title,
              ...(description !== item.description ? { description } : {}),
            }
          : { description };
      return commitOperation({
        ...operationMetadata(itemId),
        type: "UPDATE_ITEM",
        payload,
        baseVersion: item.version,
      });
    },
    deleteItem(itemId: string) {
      if (!Object.hasOwn(state.items, itemId)) return false;
      return commitOperation({
        ...operationMetadata(itemId),
        type: "DELETE_ITEM",
        payload: null,
        baseVersion: state.items[itemId].version,
      });
    },
    moveItem(input: MoveItemInput) {
      const move =
        "direction" in input
          ? resolveDirectionalMove(input.itemId, input.direction, input.filters)
          : input;
      if (!move || !Object.hasOwn(state.items, move.itemId)) return false;
      return commitOperation({
        ...operationMetadata(move.itemId),
        type: "MOVE_ITEM",
        payload: { stageId: move.stageId, beforeItemId: move.beforeItemId },
        baseVersion: state.items[move.itemId].version,
      });
    },
  });

  function resolveDirectionalMove(
    itemId: string,
    direction: ItemMoveDirection,
    filters: ItemFilters = {},
  ): ItemMove | undefined {
    if (!Object.hasOwn(state.items, itemId)) return undefined;
    const item = state.items[itemId];
    if (direction === "left" || direction === "right") {
      const index = state.stageOrder.indexOf(item.stageId);
      const stageId =
        state.stageOrder[index + (direction === "right" ? 1 : -1)];
      return stageId === undefined
        ? undefined
        : { itemId, stageId, beforeItemId: null };
    }

    // Resolve visible neighbors from the latest store, not a prior UI render.
    const visibleIds = state.itemOrderByStage[item.stageId].filter((id) =>
      matchesFilters(state.items[id], filters),
    );
    const index = visibleIds.indexOf(itemId);
    if (index < 0) return undefined;
    if (direction === "up" && index > 0) {
      return {
        itemId,
        stageId: item.stageId,
        beforeItemId: visibleIds[index - 1],
      };
    }
    if (direction === "down" && index < visibleIds.length - 1) {
      return {
        itemId,
        stageId: item.stageId,
        beforeItemId: visibleIds[index + 2] ?? null,
      };
    }
    return undefined;
  }

  // Remote transactions serialize with local writes. User actions can still be
  // optimistic during the transaction; replay those unsaved intents on publish.
  async function syncCommit(run: () => Promise<SavedWorkspace>) {
    await flush();
    if (syncWriting) await syncWriting;
    const priorRevision = state.persistedLocalRevision;
    syncWriting = run();
    try {
      const saved = await syncWriting;
      const revisionDelta = (saved.syncMetadata?.localRevision ?? priorRevision) - priorRevision;
      if (revisionDelta > 0) for (const write of writes) {
        write.expectedRevision += revisionDelta;
        write.snapshot = { ...write.snapshot, syncMetadata: { ...write.snapshot.syncMetadata,
          localRevision: write.snapshot.syncMetadata.localRevision + revisionDelta } };
      }
      publishSaved(saved);
      return saved;
    } finally {
      syncWriting = undefined;
    }
  }

  function publishSaved(saved: SavedWorkspace) {
    if (!saved.syncMetadata) throw new Error("Missing synchronized metadata.");
    let visible = { ...state, ...saved, syncMetadata: saved.syncMetadata };
    for (const write of writes) {
      // Preserve the optimistic view of a newly deleted target until its local
      // write durably records the conflict. Its intent never disappears.
      if (!canReplay(visible, write.operation)) {
        visible = state;
        break;
      }
      visible = applyOperationData(visible, write.operation);
    }
    const accepted = (saved.syncMetadata.recentAcknowledgments ?? []).filter((ack) =>
      !(state.syncMetadata.recentAcknowledgments ?? []).some((prior) => prior.operationId === ack.operationId)).length;
    publish({
      ...visible,
      pendingOperations: [
        ...saved.pendingOperations,
        ...writes.map((write) => write.operation),
      ],
      uploadedCount: state.uploadedCount + accepted,
      syncMetadata: {
        ...saved.syncMetadata,
        localRevision: saved.syncMetadata.localRevision + writes.length,
      },
      persistedLocalRevision: saved.syncMetadata.localRevision,
      selectedItemId:
        state.selectedItemId && visible.items[state.selectedItemId]
          ? state.selectedItemId
          : null,
    });
  }

  return Object.freeze({
    getSnapshot: () => state,
    getServerSnapshot: () => initialState,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    actions,
    persistence: Object.freeze({
      exportRecovery: () => repository ? repository.exportRecovery(state.workspace.id) : Promise.resolve(state),
      initialize,
      flush,
      async retry() {
        if (resetting) return resetting;
        if (state.restoration !== "ready") return initialize();
        writeError = undefined;
        publish({ ...state, storageError: null });
        await flush();
      },
      read: () => repository?.getWorkspace(state.workspace.id),
    }),
    sync: Object.freeze({
      reject(context: ConflictContext) {
        if (!repository) throw new Error("Sync requires durable storage.");
        return syncCommit(() =>
          repository.sync.reject(state.workspace.id, context),
        );
      },
      async resolve(
        conflictId: string,
        choice: "mine" | "server",
        expectedVersion: number,
      ) {
        if (!repository) throw new Error("Sync requires durable storage.");
        const repo = repository;
        const run = () =>
          syncCommit(() =>
            repo.sync.resolve(
              state.workspace.id,
              conflictId,
              choice,
              expectedVersion,
            ),
          );
        if (typeof navigator !== "undefined" && navigator.locks)
          await navigator.locks.request(
            `relay-sync:${state.workspace.cachedForUserId}:${state.workspace.id}`,
            run,
          );
        else await run();
        publish({ ...state, syncRequest: state.syncRequest + 1 });
      },
      phase(phase: SyncPhase) {
        if (state.syncPhase !== phase)
          publish({
            ...state,
            syncPhase: transitionSyncPhase(state.syncPhase, phase),
          });
      },
      async apply(remote: RemoteOperation, currentVersion: number) {
        if (!repository) throw new Error("Sync requires durable storage.");
        const cursor = state.syncMetadata.confirmedServerVersion ?? 0;
        const own = state.pendingOperations.some((op) => op.id === remote.operation.id) ||
          state.syncMetadata.recentAcknowledgments?.some((ack) => ack.operationId === remote.operation.id);
        const saved = await syncCommit(() =>
          repository.sync.apply(state.workspace.id, remote, currentVersion),
        );
        if (!own && remote.serverVersion > cursor) {
          const changes = { ...state.remoteChanges };
          delete changes[remote.operation.entityId];
          changes[remote.operation.entityId] = { operationId: remote.operation.id, timestamp: Date.now(), type: remote.operation.type };
          publish({ ...state, remoteChanges: Object.fromEntries(Object.entries(changes).slice(-50)) });
        }
        return saved;
      },
      snapshot(snapshot: SavedWorkspace) {
        if (!repository) throw new Error("Sync requires durable storage.");
        return syncCommit(() => repository.sync.snapshot(snapshot));
      },
      checked(version: number, complete = false) {
        if (!repository) throw new Error("Sync requires durable storage.");
        return syncCommit(() =>
          repository.sync.checked(state.workspace.id, version, complete),
        );
      },
      async markSubmitted(operation: Operation) {
        if (!repository) throw new Error("Sync requires durable storage.");
        return repository.sync.markSubmitted(state.workspace.id, operation);
      },
      async receipt(operation: Operation, ack: OperationAcknowledgment) {
        if (!repository) throw new Error("Sync requires durable storage.");
        return syncCommit(() =>
          repository.sync.receipt(state.workspace.id, operation, ack),
        );
      },
      async releaseSubmission() {
        await repository?.sync.releaseSubmission(state.workspace.id);
      },
      request() {
        publish({ ...state, syncRequest: state.syncRequest + 1 });
      },
      editing(entityId: string | null) {
        if (entityId !== state.editingEntityId)
          publish({ ...state, editingEntityId: entityId, syncRequest: state.syncRequest + 1 });
      },
    }),
    presence: Object.freeze({
      update(patch: Partial<PresenceState>) {
        if (Object.entries(patch).some(([key, value]) => state.presence[key as keyof PresenceState] !== value))
          publish({ ...state, presence: { ...state.presence, ...patch } });
      },
      editing(itemId: string | null) {
        publish({ ...state, presence: { ...state.presence, editingItemId: itemId, activeUntil: itemId ? Date.now() + EDITING_TTL_MS : 0 } });
      },
    }),
    realtime: Object.freeze({
      update(patch: Partial<RealtimeState>) {
        if (Object.entries(patch).some(([key, value]) => state.realtime[key as keyof RealtimeState] !== value))
          publish({ ...state, realtime: { ...state.realtime, ...patch } });
      },
    }),
    upload: Object.freeze({
      async prepare() {
        if (!repository) return undefined;
        await flush();
        const saved = await repository.getWorkspace(state.workspace.id);
        if (!saved?.syncMetadata) return undefined;
        if (state.unsavedOperationCount > 0) return undefined;
        if (
          saved.syncMetadata.localRevision !== state.syncMetadata.localRevision
        ) {
          const error = new Error(
            "This workspace was edited in another tab. Reopen it before continuing uploads.",
          );
          error.name = "StaleWorkspaceError";
          throw error;
        }
        // Incorporate acknowledgments from another tab, retaining the current UI.
        publish({ ...state, ...saved, syncMetadata: saved.syncMetadata });
        return saved;
      },
      async acknowledge(operation: Operation, ack: OperationAcknowledgment) {
        if (!repository) return;
        await syncCommit(async () => {
          await repository.acknowledge(operation, ack);
          const saved = await repository.getWorkspace(state.workspace.id);
          if (!saved)
            throw new Error("Missing workspace after acknowledgment.");
          return saved;
        });
      },
      async fail(failure: OperationFailure) {
        const metadata = await repository?.setUploadFailure(
          state.workspace.id,
          failure,
        );
        if (metadata)
          publish({
            ...state,
            syncMetadata: {
              ...metadata,
              localRevision: state.syncMetadata.localRevision,
            },
          });
      },
      async retry() {
        const metadata = await repository?.setUploadFailure(
          state.workspace.id,
          null,
        );
        if (metadata)
          publish({
            ...state,
            syncRequest: state.syncRequest + 1,
            syncMetadata: {
              ...metadata,
              localRevision: state.syncMetadata.localRevision,
            },
          });
      },
      setActive(uploadingOperationId: string | null) {
        if (state.uploadingOperationId !== uploadingOperationId)
          publish({ ...state, uploadingOperationId });
      },
      storageFailure(error: unknown) {
        publish({ ...state, storageError: describeStorageError(error) });
      },
    }),
    // Explicit developer tooling, outside the five supported domain actions.
    development:
      process.env.NODE_ENV === "development" && workspace.source !== "server"
        ? Object.freeze({ resetWorkspace })
        : undefined,
    // UI selection and browser connectivity are not domain mutations and never
    // count as pending operations. Neither method can edit workspace entities.
    selectItem(itemId: string | null) {
      if (
        itemId === state.selectedItemId ||
        (itemId !== null && !Object.hasOwn(state.items, itemId))
      )
        return;
      publish({ ...state, selectedItemId: itemId });
    },
    setOnline(online: boolean) {
      const syncStatus = online ? "local" : "offline";
      const reconnecting = online && state.syncStatus === "offline";
      const failure = state.syncMetadata.uploadFailure;
      if (syncStatus !== state.syncStatus)
        publish({
          ...state,
          syncStatus,
          syncPhase: transitionSyncPhase(
            state.syncPhase,
            online ? "idle" : "offline",
          ),
        });
      if (reconnecting && failure?.kind === "temporary" && repository)
        void repository.resumeTemporaryFailure(state.workspace.id).then(() => {
          if (state.syncMetadata.uploadFailure === failure) publish({ ...state, syncMetadata: { ...state.syncMetadata, uploadFailure: null }, syncRequest: state.syncRequest + 1 });
        }).catch((error: unknown) => publish({ ...state, storageError: describeStorageError(error) }));
    },
    setEditingBlocked(editingBlocked: boolean) {
      if (state.editingBlocked !== editingBlocked)
        publish({
          ...state,
          editingBlocked,
          syncPhase: editingBlocked
            ? transitionSyncPhase(state.syncPhase, "error")
            : state.syncPhase,
        });
    },
  });
}

export type WorkspaceStore = ReturnType<typeof createWorkspaceStore>;
