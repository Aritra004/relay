import type { RelayDatabase, WorkspaceSyncMetadata } from "./local-db.ts";
import type {
  SavedWorkspace,
  WorkspaceSnapshot,
} from "./workspace-repository.ts";
import type { Operation } from "../components/workspace/workspace-operations.ts";
import type { OperationAcknowledgment } from "./operation-contract.ts";
import type { RemoteOperation } from "./sync-contract.ts";
import { applyRemote, localOperation, sameOperation } from "./sync-replay.ts";
import {
  OperationUploadError,
  validateAcknowledgment,
} from "./operation-upload-http.ts";
import { validateSnapshot } from "./validate-workspace.ts";
import {
  conflictingFields,
  nextUpload,
  operationBlocked,
  type ConflictContext,
  type ConflictRecord,
} from "./conflict-contract.ts";
import {
  conflictContext,
  projectPending,
  recordConflict,
  resolutionOperations,
  withConflicts,
  currentValues,
} from "./conflicts.ts";

export function confirmedSnapshot(
  snapshot: WorkspaceSnapshot,
): WorkspaceSnapshot {
  return {
    workspace: snapshot.workspace,
    stages: snapshot.stages,
    items: snapshot.items,
    stageOrder: snapshot.stageOrder,
    itemOrderByStage: snapshot.itemOrderByStage,
    pendingOperations: [],
  };
}

// Persist only changed visible records. Queue sequence numbers survive rebases.
export async function persistVisible(
  db: RelayDatabase,
  before: WorkspaceSnapshot,
  after: WorkspaceSnapshot,
) {
  validateSnapshot(after);
  const workspaceId = after.workspace.id;
  if (
    JSON.stringify([
      before.workspace,
      before.stageOrder,
      before.itemOrderByStage,
    ]) !==
    JSON.stringify([after.workspace, after.stageOrder, after.itemOrderByStage])
  )
    await db.workspaces.put({
      ...after.workspace,
      stageOrder: after.stageOrder,
      itemOrderByStage: after.itemOrderByStage,
    });
  for (const id of Object.keys(before.items))
    if (!after.items[id]) await db.workItems.delete([workspaceId, id]);
  for (const item of Object.values(after.items))
    if (JSON.stringify(item) !== JSON.stringify(before.items[item.id]))
      await db.workItems.put({ ...item, workspaceId });
  for (const id of Object.keys(before.stages))
    if (!after.stages[id]) await db.workflowStages.delete([workspaceId, id]);
  for (const stage of Object.values(after.stages))
    if (JSON.stringify(stage) !== JSON.stringify(before.stages[stage.id]))
      await db.workflowStages.put({ ...stage, workspaceId });
}

export function createSyncPersistence(
  getDatabase: () => Promise<RelayDatabase>,
  read: (id: string) => Promise<SavedWorkspace | undefined>,
) {
  async function transaction<T>(
    workspaceId: string,
    run: (
      db: RelayDatabase,
      saved: SavedWorkspace & { syncMetadata: WorkspaceSyncMetadata },
    ) => Promise<T>,
  ) {
    const db = await getDatabase();
    return db.transaction("rw", db.tables, async () => {
      const saved = await read(workspaceId);
      if (!saved?.syncMetadata)
        throw new Error("Missing workspace sync metadata.");
      return run(db, { ...saved, syncMetadata: saved.syncMetadata });
    });
  }
  async function writeQueue(
    db: RelayDatabase,
    before: readonly Operation[],
    after: readonly Operation[],
  ) {
    const beforeIds = new Set(before.map((op) => op.id));
    const afterIds = new Set(after.map((op) => op.id));
    if (after.some((op) => !beforeIds.has(op.id))) {
      await db.pendingOperations.bulkDelete(before.map((op) => op.id));
      await db.pendingOperations.bulkAdd(
        after.map((op, i) => ({ ...op, sequence: i + 1 })),
      );
      return;
    }
    for (const operation of before)
      if (!afterIds.has(operation.id))
        await db.pendingOperations.delete(operation.id);
    for (const operation of after) {
      const stored = await db.pendingOperations.get(operation.id);
      if (!stored) throw new Error("Missing pending operation.");
      const prior = { ...stored }; Reflect.deleteProperty(prior, "sequence");
      if (JSON.stringify(prior) === JSON.stringify(operation)) continue;
      await db.pendingOperations.put({
        ...operation,
        sequence: stored.sequence,
      });
    }
  }
  const rebase = (
    pending: readonly Operation[],
    base: WorkspaceSnapshot,
    prior: WorkspaceSnapshot,
    frozenId?: string,
    conflicts: readonly ConflictRecord[] = [],
  ) =>
    pending.map((op) => {
      const version =
        op.type === "RENAME_STAGE"
          ? base.stages[op.entityId]?.version
          : base.items[op.entityId]?.version;
      const priorVersion =
        op.type === "RENAME_STAGE"
          ? prior.stages[op.entityId]?.version
          : prior.items[op.entityId]?.version;
      return op.type !== "CREATE_ITEM" &&
        op.id !== frozenId &&
        !operationBlocked(op, conflicts) &&
        version !== undefined &&
        (op.baseVersion === priorVersion || priorVersion === undefined)
        ? { ...op, baseVersion: version }
        : op;
    });

  return {
    async apply(
      workspaceId: string,
      remote: RemoteOperation,
      currentServerVersion: number,
    ) {
      return transaction(workspaceId, async (db, saved) => {
        const metadata = saved.syncMetadata;
        const cursor = metadata.confirmedServerVersion;
        if (
          cursor !== undefined &&
          cursor !== null &&
          remote.serverVersion <= cursor
        )
          return saved;
        const base = await db.confirmedWorkspaces.get(workspaceId);
        if (
          !base ||
          cursor === undefined ||
          cursor === null ||
          remote.serverVersion !== cursor + 1 ||
          remote.operation.workspaceId !== workspaceId
        )
          throw new OperationUploadError(
            "validation",
            "HISTORY_GAP",
            "Remote operations are not contiguous with this workspace.",
          );
        validateSnapshot(base);
        const own = saved.pendingOperations.find(
          (op) => op.id === remote.operation.id,
        );
        if (
          own &&
          !sameOperation(own, remote, saved.workspace.cachedForUserId!)
        )
          throw new OperationUploadError(
            "conflict",
            "OPERATION_ID_REUSED",
            "A queued operation does not match its accepted server record.",
          );
        const remaining = saved.pendingOperations.filter(
          (op) => op.id !== own?.id,
        );
        const confirmed = applyRemote(base, remote);
        let conflicts = [...(metadata.conflicts ?? [])];
        if (!own)
          for (const op of remaining) {
            // A frozen request may already be accepted later in this same page.
            // Preserve its exact body until its receipt/rejection is known.
            const fields = conflictingFields(localOperation(remote), op);
            if (fields.length)
              conflicts = recordConflict(
                conflicts,
                conflictContext(
                  op,
                  confirmed,
                  remote.serverVersion,
                  fields,
                  op.entityId === remote.operation.entityId
                    ? remote.entityVersion
                    : undefined,
                ),
                saved,
              );
          }
        if (own)
          conflicts = conflicts.filter(
            (c) => c.status === "resolved" || c.operationId !== own.id,
          );
        conflicts = conflicts.map((c) => {
          if (c.status !== "unresolved") return c;
          const entity =
            (c.entityType === "stage"
              ? confirmed.stages[c.entityId]
              : confirmed.items[c.entityId]) ?? null;
          return {
            ...c,
            serverEntity: entity as ConflictContext["serverEntity"],
            serverValues: currentValues(confirmed, c.entityId, c.entityType),
            serverEntityVersion:
              entity?.version ??
              (remote.operation.entityId === c.entityId
                ? remote.entityVersion
                : c.serverEntityVersion),
            serverWorkspaceVersion: remote.serverVersion,
          };
        });
        const pending = rebase(
          remaining,
          confirmed,
          base,
          own ? undefined : metadata.submittedOperation?.id,
          conflicts,
        );
        const visible = projectPending(confirmed, pending, saved, conflicts);
        const acknowledgedAt = new Date().toISOString();
        const next = withConflicts(
          {
            ...metadata,
            confirmedServerVersion: remote.serverVersion,
            lastServerVersion: Math.max(
              metadata.lastServerVersion ?? 0,
              remote.serverVersion,
            ),
            currentServerVersion,
            receivedRemoteOperations:
              (metadata.receivedRemoteOperations ?? 0) + (own ? 0 : 1),
            recentRemoteOperations: own
              ? metadata.recentRemoteOperations
              : [remote, ...(metadata.recentRemoteOperations ?? [])].slice(
                  0,
                  20,
                ),
            ...(own
              ? {
                  submittedOperation: null,
                  acceptedSubmission: null,
                  uploadFailure: null,
                  recentAcknowledgments: [
                    {
                      operationId: own.id,
                      workspaceId,
                      entityId: own.entityId,
                      status: "accepted" as const,
                      serverVersion: remote.serverVersion,
                      entityVersion: remote.entityVersion,
                      type: own.type,
                      acknowledgedAt,
                    },
                    ...(metadata.recentAcknowledgments ?? []),
                  ].slice(0, 20),
                }
              : {}),
          },
          conflicts,
        );
        await persistVisible(db, saved, visible);
        await writeQueue(db, saved.pendingOperations, pending);
        await db.confirmedWorkspaces.put({
          ...confirmedSnapshot(confirmed),
          id: workspaceId,
        });
        await db.workspaceSyncMetadata.put(next);
        return { ...visible, syncMetadata: next };
      });
    },
    async snapshot(input: SavedWorkspace) {
      const workspaceId = input.workspace.id;
      return transaction(workspaceId, async (db, saved) => {
        const metadata = saved.syncMetadata,
          version = input.syncMetadata?.confirmedServerVersion;
        validateSnapshot(input);
        if (
          input.workspace.cachedForUserId !== saved.workspace.cachedForUserId ||
          input.pendingOperations.length ||
          version === undefined ||
          version === null ||
          version < (metadata.confirmedServerVersion ?? 0)
        )
          throw new OperationUploadError(
            "validation",
            "INVALID_SNAPSHOT",
            "The recovery snapshot does not match this workspace.",
          );
        const receipt = metadata.acceptedSubmission;
        const accepted =
          receipt && receipt.serverVersion <= version
            ? saved.pendingOperations.find(
                (op) => op.id === receipt.operationId,
              )
            : undefined;
        const remaining = saved.pendingOperations.filter(
          (op) => op.id !== accepted?.id,
        );
        // Missing history cannot justify rebasing intent. Submit the original
        // base for authoritative field checks, retaining deleted items locally.
        const pending = remaining.map((op) =>
          accepted?.entityId === op.entityId &&
          op.type !== "CREATE_ITEM" &&
          receipt!.entityVersion === (accepted.baseVersion ?? 0) + 1
            ? { ...op, baseVersion: receipt!.entityVersion }
            : op,
        );
        let conflicts = [...(metadata.conflicts ?? [])];
        if (
          metadata.syncConflict &&
          !conflicts.some((c) => c.status === "unresolved")
        ) {
          const op = pending.find(
            (op) => op.id === metadata.syncConflict?.operationId,
          );
          const legacyRemote = metadata.syncConflict.remoteOperation;
          const fields =
            op && legacyRemote
              ? conflictingFields(localOperation(legacyRemote), op)
              : [];
          if (op)
            conflicts = recordConflict(
              conflicts,
              conflictContext(
                op,
                input,
                version,
                fields.length ? fields : ["history"],
              ),
              saved,
            );
        }
        conflicts = conflicts.map((c) => {
          if (c.status !== "unresolved") return c;
          const entity =
            (c.entityType === "stage"
              ? input.stages[c.entityId]
              : input.items[c.entityId]) ?? null;
          return {
            ...c,
            serverEntity: entity as ConflictContext["serverEntity"],
            serverValues: currentValues(input, c.entityId, c.entityType),
            serverEntityVersion: entity?.version ?? c.serverEntityVersion,
            serverWorkspaceVersion: version,
          };
        });
        const visible = projectPending(input, pending, saved, conflicts);
        let next: WorkspaceSyncMetadata = {
          ...metadata,
          confirmedServerVersion: version,
          lastServerVersion: version,
          currentServerVersion: version,
          lastSnapshotAt: input.syncMetadata?.lastSnapshotAt,
          ...(accepted
            ? {
                submittedOperation: null,
                acceptedSubmission: null,
                recentAcknowledgments: [
                  {
                    ...receipt!,
                    type: accepted.type,
                    acknowledgedAt: new Date().toISOString(),
                  },
                  ...(metadata.recentAcknowledgments ?? []),
                ].slice(0, 20),
              }
            : {}),
        };
        next = withConflicts(next, conflicts);
        await persistVisible(db, saved, visible);
        await writeQueue(db, saved.pendingOperations, pending);
        await db.confirmedWorkspaces.put({
          ...confirmedSnapshot(input),
          id: workspaceId,
        });
        await db.workspaceSyncMetadata.put(next);
        return { ...visible, syncMetadata: next };
      });
    },
    async markSubmitted(workspaceId: string, operation: Operation) {
      return transaction(workspaceId, async (db, saved) => {
        if (
          saved.syncMetadata.submittedOperation?.id !== operation.id &&
          nextUpload(
            saved.pendingOperations,
            saved.syncMetadata.conflicts ?? [],
          )?.id !== operation.id
        )
          throw new Error(
            "Only the first independent operation may be submitted.",
          );
        if (
          saved.syncMetadata.submittedOperation &&
          saved.syncMetadata.submittedOperation.id !== operation.id
        )
          throw new OperationUploadError(
            "validation",
            "INVALID_SUBMISSION",
            "A different operation already has an outstanding request.",
          );
        const next = {
          ...saved.syncMetadata,
          submittedOperation:
            saved.syncMetadata.submittedOperation ?? operation,
        };
        await db.workspaceSyncMetadata.put(next);
        return next.submittedOperation;
      });
    },
    async receipt(
      workspaceId: string,
      operation: Operation,
      ack: OperationAcknowledgment,
    ) {
      validateAcknowledgment(ack, operation);
      return transaction(workspaceId, async (db, saved) => {
        const next = {
          ...saved.syncMetadata,
          acceptedSubmission: ack,
          lastServerVersion: Math.max(
            saved.syncMetadata.lastServerVersion ?? 0,
            ack.serverVersion,
          ),
        };
        await db.workspaceSyncMetadata.put(next);
        return { ...saved, syncMetadata: next };
      });
    },
    async releaseSubmission(workspaceId: string) {
      return transaction(workspaceId, async (db, saved) => {
        await db.workspaceSyncMetadata.put({
          ...saved.syncMetadata,
          submittedOperation: null,
          acceptedSubmission: null,
        });
      });
    },
    async reject(workspaceId: string, context: ConflictContext) {
      return transaction(workspaceId, async (db, saved) => {
        if (
          !saved.pendingOperations.some((op) => op.id === context.operation.id)
        )
          return saved;
        const conflicts = recordConflict(
          saved.syncMetadata.conflicts ?? [],
          context,
          saved,
        );
        const next = withConflicts(
          {
            ...saved.syncMetadata,
            submittedOperation: null,
            acceptedSubmission: null,
          },
          conflicts,
        );
        await db.workspaceSyncMetadata.put(next);
        return { ...saved, syncMetadata: next };
      });
    },
    async resolve(
      workspaceId: string,
      conflictId: string,
      choice: "mine" | "server",
      expectedVersion: number,
    ) {
      return transaction(workspaceId, async (db, saved) => {
        const conflict = saved.syncMetadata.conflicts?.find(
          (c) => c.id === conflictId && c.status === "unresolved",
        );
        if (!conflict) return saved;
        if (conflict.serverWorkspaceVersion !== expectedVersion)
          throw new Error(
            "A newer server version arrived. Review both versions again.",
          );
        const base = await db.confirmedWorkspaces.get(workspaceId);
        if (
          !base ||
          (saved.syncMetadata.confirmedServerVersion ?? -1) <
            conflict.serverWorkspaceVersion
        )
          throw new Error(
            "Sync the latest server changes before choosing a version.",
          );
        validateSnapshot(base);
        if (
          saved.syncMetadata.submittedOperation &&
          operationBlocked(saved.syncMetadata.submittedOperation, [conflict])
        )
          throw new Error(
            "A previous request is still being checked. Sync before choosing a version.",
          );
        const { pending, replacements } = resolutionOperations(
          conflict,
          choice,
          base,
          saved,
          saved.pendingOperations,
        );
        const conflicts = (saved.syncMetadata.conflicts ?? []).map((c) =>
          c.id === conflictId
            ? {
                ...c,
                status: "resolved" as const,
                resolution: choice,
                resolvedAt: new Date().toISOString(),
                replacementOperationId: replacements[0]?.id,
              }
            : c,
        );
        const visible = projectPending(base, pending, saved, conflicts);
        const next = withConflicts(
          {
            ...saved.syncMetadata,
            localRevision: saved.syncMetadata.localRevision + 1,
          },
          conflicts,
        );
        await persistVisible(db, saved, visible);
        await writeQueue(db, saved.pendingOperations, pending);
        await db.workspaceSyncMetadata.put(next);
        return { ...visible, syncMetadata: next };
      });
    },
    async checked(
      workspaceId: string,
      currentServerVersion: number,
      complete: boolean,
    ) {
      return transaction(workspaceId, async (db, saved) => {
        const synced =
          complete &&
          !saved.pendingOperations.length &&
          saved.syncMetadata.confirmedServerVersion === currentServerVersion &&
          !saved.syncMetadata.syncConflict;
        const next = {
          ...saved.syncMetadata,
          currentServerVersion,
          ...(synced
            ? { lastSyncedAt: new Date().toISOString(), uploadFailure: null }
            : {}),
        };
        await db.workspaceSyncMetadata.put(next);
        return { ...saved, syncMetadata: next };
      });
    },
  };
}
