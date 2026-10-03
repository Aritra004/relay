import type {
  WorkspaceData,
  WorkspaceDetails,
} from "../components/workspace/workspace-data.ts";
import type { Operation } from "../components/workspace/workspace-operations.ts";
import {
  openLocalDatabase,
  type RelayDatabase,
  type WorkspaceSyncMetadata,
} from "./local-db.ts";

import {
  validateSnapshot,
  validateSyncMetadata,
} from "./validate-workspace.ts";
import { InvalidLocalDataError } from "./local-storage-errors.ts";
import type {
  OperationAcknowledgment,
  OperationFailure,
} from "./operation-contract.ts";
import {
  submittedOperation,
  validateAcknowledgment,
} from "./operation-upload-http.ts";
import {
  createSyncPersistence,
  confirmedSnapshot,
  persistVisible,
} from "./sync-persistence.ts";
import { applyOperationData } from "../components/workspace/apply-workspace-operation.ts";
import {
  canReplay,
  classifyRemoteOperation,
  localOperation,
} from "./sync-replay.ts";
import { conflictingFields } from "./conflict-contract.ts";
import { conflictContext, recordConflict, withConflicts, projectPending } from "./conflicts.ts";

export type { WorkspaceSyncMetadata } from "./local-db.ts";

// A durable domain snapshot, without selection, connection state, or UI drafts.
// An existing WorkspaceState can be passed directly to saveWorkspace.
export interface WorkspaceSnapshot extends WorkspaceData {
  readonly workspace: WorkspaceDetails;
  readonly pendingOperations: readonly Operation[];
}

export interface SavedWorkspace extends WorkspaceSnapshot {
  readonly syncMetadata: WorkspaceSyncMetadata | null;
}

function withoutWorkspaceId<T extends { readonly workspaceId: string }>(
  record: T,
) {
  const entity = { ...record };
  Reflect.deleteProperty(entity, "workspaceId");
  return entity as Omit<T, "workspaceId">;
}

// The optional opener gives tests an isolated database. Application callers use
// the shared repository below; opening remains lazy and safe during SSR imports.
export function createWorkspaceRepository(
  getDatabase: () => Promise<RelayDatabase> = openLocalDatabase,
) {
  const repository = {
    // Bypass validation for a recovery export, never for uploading or rendering.
    async exportRecovery(workspaceId: string): Promise<Record<string, unknown>> {
      const db = await getDatabase();
      return db.transaction("r", db.tables, async () => ({
        workspace: await db.workspaces.get(workspaceId),
        stages: await db.workflowStages.where({ workspaceId }).toArray(),
        items: await db.workItems.where({ workspaceId }).toArray(),
        pendingOperations: await db.pendingOperations.where({ workspaceId }).sortBy("sequence"),
        syncMetadata: await db.workspaceSyncMetadata.get(workspaceId),
        confirmed: await db.confirmedWorkspaces.get(workspaceId),
        backups: await db.recoveryBackups.where({ workspaceId }).toArray(),
      }));
    },
    async recoverServerWorkspace(fresh: SavedWorkspace): Promise<SavedWorkspace> {
      validateSnapshot(fresh);
      if (fresh.workspace.source !== "server" || fresh.pendingOperations.length || !fresh.syncMetadata) throw new InvalidLocalDataError("An authorized server snapshot is required.");
      const workspaceId = fresh.workspace.id;
      const db = await getDatabase();
      return db.transaction("rw", db.tables, async () => {
        const record = await db.workspaces.get(workspaceId);
        if (!record || record.cachedForUserId !== fresh.workspace.cachedForUserId || record.source !== "server") throw new InvalidLocalDataError("The cache belongs to another account.");
        const metadata = await db.workspaceSyncMetadata.get(workspaceId);
        if (!metadata) throw new InvalidLocalDataError("Missing queue metadata. Download recovery data before repairing this cache.");
        validateSyncMetadata(metadata, workspaceId);
        const queued = await db.pendingOperations.where({ workspaceId }).sortBy("sequence");
        if (queued.some((op) => !Number.isSafeInteger(op.sequence) || op.sequence < 0)) throw new InvalidLocalDataError("Invalid queue order. Download recovery data before repairing this cache.");
        const pending = queued.map((stored) => { const op = { ...stored }; Reflect.deleteProperty(op, "sequence"); return op; });
        validateSnapshot({ ...fresh, pendingOperations: pending });
        const raw = await repository.exportRecovery(workspaceId);
        delete raw.backups;
        await db.recoveryBackups.add({ id: crypto.randomUUID(), workspaceId, createdAt: new Date().toISOString(), data: raw });
        const visible = projectPending(fresh, pending, fresh, metadata.conflicts ?? []);
        const recovered: SavedWorkspace = { ...visible, syncMetadata: {
          ...metadata, confirmedServerVersion: null,
          localGeneration: crypto.randomUUID(),
          serverAccess: "authorized",
          recoveryMessage: "Rebuilt the cached board from the server. Pending changes and conflicts were preserved. Original records are available in the recovery download.",
        } };
        await repository.saveWorkspace(recovered);
        await db.confirmedWorkspaces.put({ ...confirmedSnapshot(fresh), id: workspaceId });
        return recovered;
      });
    },
    // This is a developer database reset, never a domain deletion or operation.
    development:
      process.env.NODE_ENV === "development"
        ? Object.freeze({
            async resetLocalDatabase(
              seed: WorkspaceSnapshot,
            ): Promise<SavedWorkspace> {
              if (process.env.NODE_ENV !== "development") {
                throw new Error(
                  "Local database reset is available only in development.",
                );
              }
              validateSnapshot(seed);
              if (seed.pendingOperations.length > 0) {
                throw new Error(
                  "A clean development seed cannot contain pending operations.",
                );
              }
              const db = await getDatabase();
              return db.transaction("rw", db.tables, async () => {
                for (const table of db.tables) await table.clear();
                await repository.saveWorkspace({
                  ...seed,
                  syncMetadata: {
                    workspaceId: seed.workspace.id,
                    localRevision: 0,
                    localGeneration: crypto.randomUUID(),
                    lastServerVersion: null,
                    lastSyncedAt: null,
                  },
                });
                const saved = await repository.getWorkspace(seed.workspace.id);
                if (!saved)
                  throw new Error(
                    "Development workspace could not be reseeded.",
                  );
                return saved;
              });
            },
          })
        : undefined,

    async initialize(): Promise<void> {
      await getDatabase();
    },

    // First initialization only. Even a clean existing cache is left untouched
    // until the sync engine reconciles it. The write lock protects other tabs.
    async initializeServerWorkspace(
      input: SavedWorkspace,
    ): Promise<SavedWorkspace> {
      const snapshot = structuredClone(input);
      validateSnapshot(snapshot);
      if (
        snapshot.workspace.source !== "server" ||
        !snapshot.workspace.cachedForUserId ||
        snapshot.pendingOperations.length ||
        !snapshot.syncMetadata
      ) {
        throw new InvalidLocalDataError(
          "Server initialization requires an authorized clean snapshot.",
        );
      }
      validateSyncMetadata(snapshot.syncMetadata, snapshot.workspace.id);
      const db = await getDatabase();
      return db.transaction("rw", db.tables, async () => {
        const existing = await repository.getWorkspace(snapshot.workspace.id);
        if (existing) {
          if (
            existing.workspace.source !== "server" ||
            existing.workspace.cachedForUserId !==
              snapshot.workspace.cachedForUserId
          ) {
            throw new InvalidLocalDataError(
              "This cache belongs to a different workspace source or account.",
            );
          }
          return existing;
        }
        const workspaceId = snapshot.workspace.id;
        if (
          (await db.workflowStages.where({ workspaceId }).count()) ||
          (await db.workItems.where({ workspaceId }).count()) ||
          (await db.pendingOperations.where({ workspaceId }).count()) ||
          (await db.workspaceSyncMetadata.get(workspaceId))
        ) {
          throw new InvalidLocalDataError(
            "Orphaned cache data must be recovered before initialization.",
          );
        }
        const initialized = {
          ...snapshot,
          syncMetadata: {
            ...snapshot.syncMetadata!,
            confirmedServerVersion: snapshot.syncMetadata!.lastServerVersion,
            currentServerVersion: snapshot.syncMetadata!.lastServerVersion ?? 0,
          },
        };
        await repository.saveWorkspace(initialized);
        await db.confirmedWorkspaces.put({
          ...confirmedSnapshot(snapshot),
          id: workspaceId,
        });
        return initialized;
      });
    },

    async setServerAccess(
      workspaceId: string,
      access: "authorized" | "forbidden",
    ) {
      const db = await getDatabase();
      await db.transaction("rw", db.workspaceSyncMetadata, async () => {
        const metadata = await db.workspaceSyncMetadata.get(workspaceId);
        if (metadata)
          await db.workspaceSyncMetadata.put({
            ...metadata,
            serverAccess: access,
          });
      });
    },

    async listCachedWorkspaces() {
      const db = await getDatabase();
      return db.workspaces.toArray();
    },

    async restoreOrSeed(seed: WorkspaceSnapshot): Promise<SavedWorkspace> {
      validateSnapshot(seed);
      const db = await getDatabase();
      const workspaceId = seed.workspace.id;
      // Checking and seeding share the write lock, including across browser tabs.
      return db.transaction("rw", db.tables, async () => {
        const existing = await repository.getWorkspace(workspaceId);
        if (existing) {
          if (existing.syncMetadata) return existing;
          const syncMetadata = {
            workspaceId,
            localRevision: existing.pendingOperations.length,
            lastServerVersion: null,
            lastSyncedAt: null,
          };
          await db.workspaceSyncMetadata.add(syncMetadata);
          return { ...existing, syncMetadata };
        }
        // A missing workspace with leftover records is corruption, not first use.
        if (
          (await db.workflowStages.where({ workspaceId }).count()) ||
          (await db.workItems.where({ workspaceId }).count()) ||
          (await db.pendingOperations.where({ workspaceId }).count()) ||
          (await db.workspaceSyncMetadata.get(workspaceId))
        ) {
          throw new InvalidLocalDataError(
            "Orphaned workspace data must be recovered before initialization.",
          );
        }
        const syncMetadata: WorkspaceSyncMetadata = {
          workspaceId,
          localRevision: 0,
          lastServerVersion: null,
          lastSyncedAt: null,
        };
        await repository.saveWorkspace({ ...seed, syncMetadata });
        const saved = await repository.getWorkspace(workspaceId);
        if (!saved)
          throw new InvalidLocalDataError(
            "Workspace initialization did not complete.",
          );
        return saved;
      });
    },

    async commitMutation(
      input: WorkspaceSnapshot & {
        readonly syncMetadata: WorkspaceSyncMetadata;
      },
      operation: Operation,
      expectedRevision: number,
      previous?: WorkspaceSnapshot,
    ): Promise<SavedWorkspace | void> {
      const snapshot = structuredClone(input);
      validateSnapshot(snapshot);
      const workspaceId = snapshot.workspace.id;
      validateSyncMetadata(snapshot.syncMetadata, workspaceId);
      if (
        snapshot.pendingOperations.at(-1)?.id !== operation.id ||
        snapshot.syncMetadata.localRevision !== expectedRevision + 1
      ) {
        throw new InvalidLocalDataError(
          "The mutation does not match its resulting snapshot.",
        );
      }
      const db = await getDatabase();
      return db.transaction("rw", db.tables, async () => {
        const existing = await db.pendingOperations.get(operation.id);
        if (existing) {
          const { sequence, ...savedOperation } = existing;
          if (
            sequence === snapshot.syncMetadata.localRevision &&
            JSON.stringify(savedOperation) === JSON.stringify(operation)
          )
            return;
          throw new InvalidLocalDataError(
            "An operation ID was reused with different content.",
          );
        }
        const metadata = await db.workspaceSyncMetadata.get(workspaceId);
        if (
          !metadata ||
          metadata.localRevision !== expectedRevision ||
          metadata.localGeneration !== snapshot.syncMetadata.localGeneration
        ) {
          const error = new Error(
            "The persisted workspace changed in another tab.",
          );
          error.name = "StaleWorkspaceError";
          throw error;
        }
        if (!(await db.workspaces.get(workspaceId))) {
          throw new InvalidLocalDataError("Cannot edit a missing workspace.");
        }
        if (snapshot.workspace.source === "server") {
          // Apply the intent to the latest durable projection. A remote commit
          // may have landed while this optimistic local write was queued.
          const current = (await repository.getWorkspace(workspaceId))!;
          const oldCursor = snapshot.syncMetadata.confirmedServerVersion ?? -1;
          const advanced = (metadata.confirmedServerVersion ?? -1) > oldCursor;
          const recentOverlap =
            advanced &&
            metadata.recentRemoteOperations?.some(
              (remote) =>
                remote.serverVersion > oldCursor &&
                classifyRemoteOperation(localOperation(remote), operation) ===
                  "conflict",
            );
          const priorItem = previous?.items[operation.entityId],
            currentItem = current.items[operation.entityId];
          const changedField =
            advanced &&
            previous &&
            (operation.type === "UPDATE_ITEM"
              ? Object.keys(operation.payload).some(
                  (key) =>
                    priorItem?.[key as "title" | "description"] !==
                    currentItem?.[key as "title" | "description"],
                )
              : operation.type === "RENAME_STAGE"
                ? previous.stages[operation.entityId]?.name !==
                  current.stages[operation.entityId]?.name
                : operation.type === "DELETE_ITEM"
                  ? priorItem?.version !== currentItem?.version
                  : operation.type === "MOVE_ITEM"
                    ? priorItem?.stageId !== currentItem?.stageId ||
                      JSON.stringify(previous.itemOrderByStage) !==
                        JSON.stringify(current.itemOrderByStage)
                    : false);
          const replayable = canReplay(current, operation);
          const conflict = recentOverlap || changedField || !replayable;
          const visible = replayable
            ? applyOperationData(current, operation)
            : snapshot;
          await persistVisible(db, current, visible);
          const entity =
            operation.type === "RENAME_STAGE"
              ? current.stages[operation.entityId]
              : current.items[operation.entityId];
          const queued =
            !conflict &&
            operation.type !== "CREATE_ITEM" &&
            entity?.version !== undefined
              ? { ...operation, baseVersion: entity.version }
              : operation;
          await db.pendingOperations.add({
            ...queued,
            sequence: snapshot.syncMetadata.localRevision,
          });
          const base =
            (await db.confirmedWorkspaces.get(workspaceId)) ?? current;
          const fields =
            metadata.recentRemoteOperations
              ?.filter((remote) => remote.serverVersion > oldCursor)
              .flatMap((remote) =>
                conflictingFields(localOperation(remote), operation),
              ) ?? [];
          const conflicts = conflict
            ? recordConflict(
                metadata.conflicts ?? [],
                conflictContext(
                  operation,
                  base,
                  metadata.confirmedServerVersion ?? 0,
                  fields.length
                    ? [...new Set(fields)]
                    : !currentItem && operation.type !== "RENAME_STAGE"
                      ? ["delete"]
                      : ["history"],
                ),
                snapshot,
              )
            : (metadata.conflicts ?? []);
          const next = withConflicts(
            { ...metadata, localRevision: snapshot.syncMetadata.localRevision },
            conflicts,
          );
          await db.workspaceSyncMetadata.put(next);
          return {
            ...visible,
            pendingOperations: [...current.pendingOperations, queued],
            syncMetadata: next,
          };
        }
        // An acknowledgment can arrive while this optimistic write waits. Keep
        // the confirmed version without replacing any of the user's fields.
        const confirmed =
          operation.type === "RENAME_STAGE"
            ? await db.workflowStages.get([workspaceId, operation.entityId])
            : await db.workItems.get([workspaceId, operation.entityId]);
        const confirmedVersion = confirmed?.version;
        if (operation.type === "RENAME_STAGE") {
          await db.workflowStages.put({
            ...snapshot.stages[operation.entityId],
            workspaceId,
            ...(confirmedVersion === undefined
              ? {}
              : { version: confirmedVersion }),
          });
        } else if (operation.type === "DELETE_ITEM") {
          await db.workItems.delete([workspaceId, operation.entityId]);
        } else {
          await db.workItems.put({
            ...snapshot.items[operation.entityId],
            workspaceId,
            ...(confirmedVersion === undefined
              ? {}
              : { version: confirmedVersion }),
          });
        }
        if (
          ["CREATE_ITEM", "DELETE_ITEM", "MOVE_ITEM"].includes(operation.type)
        ) {
          await db.workspaces.update(workspaceId, {
            itemOrderByStage: snapshot.itemOrderByStage,
          });
        }
        const queued =
          operation.type !== "CREATE_ITEM" &&
          operation.baseVersion !== null &&
          confirmedVersion !== undefined
            ? {
                ...operation,
                baseVersion: Math.max(operation.baseVersion, confirmedVersion),
              }
            : operation;
        await db.pendingOperations.add({
          ...queued,
          sequence: snapshot.syncMetadata.localRevision,
        });
        // An offline edit never changes the last confirmed server version/time.
        await db.workspaceSyncMetadata.put({
          ...metadata,
          localRevision: snapshot.syncMetadata.localRevision,
        });
      });
    },

    async acknowledge(
      operation: Operation,
      input: OperationAcknowledgment,
    ): Promise<WorkspaceSyncMetadata> {
      const ack = validateAcknowledgment(input, operation);
      const db = await getDatabase();
      return db.transaction("rw", db.tables, async () => {
        const saved = await repository.getWorkspace(operation.workspaceId);
        if (!saved?.syncMetadata)
          throw new InvalidLocalDataError("Missing workspace metadata.");
        if (!saved.pendingOperations.some((op) => op.id === operation.id))
          return saved.syncMetadata;
        if (saved.pendingOperations[0]?.id !== operation.id)
          throw new InvalidLocalDataError(
            "Only the first queued operation may be acknowledged.",
          );
        const sync = createSyncPersistence(
          getDatabase,
          repository.getWorkspace,
        );
        const recorded = await sync.receipt(
          operation.workspaceId,
          operation,
          ack,
        );
        if (
          ack.serverVersion !==
          (saved.syncMetadata.confirmedServerVersion ?? -1) + 1
        )
          return recorded.syncMetadata;
        const applied = await sync.apply(
          operation.workspaceId,
          {
            operation: submittedOperation(operation),
            authorId: saved.workspace.cachedForUserId!,
            serverVersion: ack.serverVersion,
            entityVersion: ack.entityVersion,
          },
          ack.serverVersion,
        );
        return applied.syncMetadata;
      });
    },

    async setUploadFailure(
      workspaceId: string,
      failure: OperationFailure | null,
    ): Promise<WorkspaceSyncMetadata> {
      const db = await getDatabase();
      return db.transaction(
        "rw",
        db.workspaceSyncMetadata,
        db.pendingOperations,
        async () => {
          const metadata = await db.workspaceSyncMetadata.get(workspaceId);
          if (!metadata)
            throw new InvalidLocalDataError("Missing workspace metadata.");
          const next = { ...metadata, uploadFailure: failure };
          await db.workspaceSyncMetadata.put(next);
          return next;
        },
      );
    },
    async resumeTemporaryFailure(workspaceId: string) {
      const db = await getDatabase();
      await db.transaction("rw", db.workspaceSyncMetadata, async () => {
        const metadata = await db.workspaceSyncMetadata.get(workspaceId);
        if (metadata?.uploadFailure?.kind === "temporary") await db.workspaceSyncMetadata.put({ ...metadata, uploadFailure: null });
      });
    },

    // Replace ONE complete workspace snapshot atomically, including removals.
    // Omitted metadata preserves the existing value; null explicitly clears it.
    // This is an explicit cache save, not an automatic per-keystroke writer or
    // a merge protocol for concurrent tabs. The last committed snapshot wins.
    async saveWorkspace(
      input: WorkspaceSnapshot & {
        readonly syncMetadata?: WorkspaceSyncMetadata | null;
      },
    ): Promise<void> {
      // Capture only durable fields before awaiting storage. Caller mutations or
      // extra UI properties must not change what this save writes.
      const snapshot = structuredClone({
        workspace: input.workspace,
        stages: input.stages,
        items: input.items,
        stageOrder: input.stageOrder,
        itemOrderByStage: input.itemOrderByStage,
        pendingOperations: input.pendingOperations,
        syncMetadata: input.syncMetadata,
      });
      validateSnapshot(snapshot);
      const workspaceId = snapshot.workspace.id;
      if (snapshot.syncMetadata)
        validateSyncMetadata(snapshot.syncMetadata, workspaceId);
      const db = await getDatabase();
      await db.transaction("rw", db.tables, async () => {
        await db.workspaces.put({
          ...snapshot.workspace,
          stageOrder: snapshot.stageOrder,
          itemOrderByStage: snapshot.itemOrderByStage,
        });
        await db.workflowStages.where({ workspaceId }).delete();
        await db.workItems.where({ workspaceId }).delete();
        await db.pendingOperations.where({ workspaceId }).delete();
        await db.workflowStages.bulkAdd(
          Object.values(snapshot.stages).map((stage) => ({
            ...stage,
            workspaceId,
          })),
        );
        await db.workItems.bulkAdd(
          Object.values(snapshot.items).map((item) => ({
            ...item,
            workspaceId,
          })),
        );
        // Array order is authoritative, not operation timestamps or UUID order.
        // add rejects an ID belonging to another workspace instead of replacing it.
        await db.pendingOperations.bulkAdd(
          snapshot.pendingOperations.map((operation, sequence) => ({
            ...operation,
            sequence,
          })),
        );
        if (snapshot.syncMetadata === null) {
          await db.workspaceSyncMetadata.delete(workspaceId);
        } else if (snapshot.syncMetadata !== undefined) {
          await db.workspaceSyncMetadata.put(snapshot.syncMetadata);
        }
      });
    },

    async getWorkspace(
      workspaceId: string,
    ): Promise<SavedWorkspace | undefined> {
      const db = await getDatabase();
      // Read all tables in one transaction so a simultaneous save cannot produce
      // a mixture of old ordering and new entities (or a partially replaced queue).
      return db.transaction("r", db.tables, async () => {
        const record = await db.workspaces.get(workspaceId);
        if (!record) return undefined;
        const { stageOrder, itemOrderByStage, ...workspace } = record;
        const stages = await db.workflowStages.where({ workspaceId }).toArray();
        const items = await db.workItems.where({ workspaceId }).toArray();
        const pending = await db.pendingOperations
          .where({ workspaceId })
          .sortBy("sequence");
        const syncMetadata = await db.workspaceSyncMetadata.get(workspaceId);
        const snapshot: SavedWorkspace = {
          workspace,
          stageOrder,
          itemOrderByStage,
          stages: Object.fromEntries(
            stages.map((stage) => [stage.id, withoutWorkspaceId(stage)]),
          ) as WorkspaceData["stages"],
          items: Object.fromEntries(
            items.map((item) => [item.id, withoutWorkspaceId(item)]),
          ),
          pendingOperations: pending.map(({ sequence, ...operation }) => {
            if (!Number.isSafeInteger(sequence) || sequence < 0) {
              throw new InvalidLocalDataError(
                "Stored pending operation has an invalid queue sequence.",
              );
            }
            return operation;
          }),
          syncMetadata: syncMetadata ?? null,
        };
        validateSnapshot(snapshot);
        if (syncMetadata) validateSyncMetadata(syncMetadata, workspaceId);
        return snapshot;
      });
    },

    // Sync progress can be updated/read without rewriting the board or queue.
    async saveSyncMetadata(metadata: WorkspaceSyncMetadata): Promise<void> {
      validateSyncMetadata(metadata, metadata.workspaceId);
      const record = structuredClone(metadata);
      const db = await getDatabase();
      await db.transaction(
        "rw",
        db.workspaces,
        db.workspaceSyncMetadata,
        async () => {
          if (!(await db.workspaces.get(record.workspaceId))) {
            throw new Error(
              "Cannot save sync metadata for a missing workspace.",
            );
          }
          await db.workspaceSyncMetadata.put(record);
        },
      );
    },

    async getSyncMetadata(
      workspaceId: string,
    ): Promise<WorkspaceSyncMetadata | undefined> {
      const db = await getDatabase();
      return db.workspaceSyncMetadata.get(workspaceId);
    },
  };
  return Object.freeze({
    ...repository,
    sync: createSyncPersistence(getDatabase, repository.getWorkspace),
  });
}

export type WorkspaceRepository = ReturnType<typeof createWorkspaceRepository>;
export const workspaceRepository = createWorkspaceRepository();
