import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { RelayDatabase } from "./local-db.ts";
import { createWorkspaceRepository } from "./workspace-repository.ts";
import { createWorkspaceStore } from "../components/workspace/workspace-store.ts";
import { startWorkspaceSync } from "./workspace-sync.ts";
import { applyRemote } from "./sync-replay.ts";
import { submittedOperation, OperationUploadError } from "./operation-upload-http.ts";
import { conflictingFields, entityValues, intentValues } from "./conflict-contract.ts";

export async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail("Timed out waiting for sync state");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
export const emptyPull = async (workspaceId, afterVersion) => ({ status: "ok", workspaceId,
  startingVersion: afterVersion, endingVersion: afterVersion, currentWorkspaceVersion: afterVersion, operations: [], hasMore: false });

export async function syncFixture(t) {
  const db = new RelayDatabase(`relay-sync-${crypto.randomUUID()}`);
  await db.open();
  const workspaceId = crypto.randomUUID(), accountId = crypto.randomUUID(), stageId = crypto.randomUUID(), otherStage = crypto.randomUUID();
  const seed = { workspace: { id: workspaceId, name: "Sync test", members: ["You"], source: "server", cachedForUserId: accountId },
    stages: Object.fromEntries([stageId, otherStage].map((id, i) => [id, { id, name: i ? "Done" : "Ready", description: "", version: 0 }])),
    items: {}, stageOrder: [stageId, otherStage], itemOrderByStage: { [stageId]: [], [otherStage]: [] }, pendingOperations: [],
    syncMetadata: { workspaceId, localRevision: 0, lastServerVersion: 0, confirmedServerVersion: 0, currentServerVersion: 0, lastSyncedAt: null } };
  const repository = createWorkspaceRepository(async () => db);
  await repository.initializeServerWorkspace(seed);
  const store = createWorkspaceStore({ savedWorkspace: seed, repository });
  await store.persistence.initialize();
  let server = structuredClone(seed);
  const log = [], events = [], stops = [];
  let version = 0, floor = 0, batchSize = 100;
  const accept = (operation, authorId = accountId) => {
    const op = submittedOperation(operation);
    const existing = log.find((row) => row.operation.id === op.id);
    if (existing) return existing;
    const entity = op.type === "RENAME_STAGE" ? server.stages[op.entityId] : server.items[op.entityId];
    const tombstone = log.filter((r) => r.operation.entityId === op.entityId && r.operation.type === "DELETE_ITEM").at(-1);
    const fields = op.type === "CREATE_ITEM" ? [] : !entity && op.type !== "DELETE_ITEM" ? ["delete"] :
      [...new Set(log.filter((r) => r.entityVersion > op.baseVersion).flatMap((r) => conflictingFields(r.operation, op)))];
    if (fields.length) throw new OperationUploadError("conflict", "FIELD_CONFLICT", "Choose a version.", {
      operation: op, entityId: op.entityId, entityType: op.type === "RENAME_STAGE" ? "stage" : "item", fields,
      clientValues: intentValues(op), serverValues: entityValues(entity ?? null), serverEntity: entity ?? null,
      serverEntityVersion: entity?.version ?? tombstone?.entityVersion ?? 0, serverWorkspaceVersion: version,
    });
    const remote = { operation: op, authorId, serverVersion: ++version, entityVersion: op.type === "CREATE_ITEM" ? 1 : (entity?.version ?? tombstone?.entityVersion ?? 0) + 1 };
    server = applyRemote(server, remote);
    log.push(remote);
    return remote;
  };
  const ack = (remote) => ({ operationId: remote.operation.id, workspaceId, entityId: remote.operation.entityId,
    status: "accepted", serverVersion: remote.serverVersion, entityVersion: remote.entityVersion });
  const options = {
    verifyAccount: async () => true, lock: async (_name, run) => run(), retryDelay: () => 10,
    pull: async (_id, afterVersion) => {
      events.push(`pull:${afterVersion}`);
      if (afterVersion < floor) return { status: "snapshot-required", workspaceId, currentWorkspaceVersion: version, reason: "OPERATION_HISTORY_UNAVAILABLE" };
      const operations = log.filter((row) => row.serverVersion > afterVersion).slice(0, batchSize);
      const endingVersion = operations.at(-1)?.serverVersion ?? afterVersion;
      return { status: "ok", workspaceId, startingVersion: afterVersion, endingVersion, currentWorkspaceVersion: version, operations, hasMore: endingVersion < version };
    },
    submit: async (op) => { events.push(`push:${op.id}`); return ack(accept(op)); },
    receipt: async (_id, id) => log.find((row) => row.operation.id === id) ?? null,
    snapshot: async () => ({ ...structuredClone(server), pendingOperations: [], syncMetadata: { ...seed.syncMetadata,
      confirmedServerVersion: version, currentServerVersion: version, lastServerVersion: version, lastSnapshotAt: new Date().toISOString() } }),
  };
  const operation = (type, entityId, payload, baseVersion = 1) => ({ id: crypto.randomUUID(), workspaceId, entityId,
    timestamp: new Date().toISOString(), type, payload, baseVersion });
  const create = (title = "Remote", targetStage = stageId) => operation("CREATE_ITEM", crypto.randomUUID(),
    { title, description: "", stageId: targetStage, assignee: "Unassigned", label: "Product", version: 1 }, null);
  const start = (overrides = {}, target = store) => {
    const stop = startWorkspaceSync(target, { ...options, ...overrides }); stops.push(stop); return stop;
  };
  t.after(async () => { stops.forEach((stop) => stop()); await new Promise((resolve) => setTimeout(resolve, 30)); await db.delete(); });
  return { db, repository, store, seed, stageId, otherStage, workspaceId, accountId, log, events, options, accept, ack,
    operation, create, start, server: () => server, pruneBefore: (v) => { floor = v; }, batch: (size) => { batchSize = size; } };
}
