import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { Dexie } from "dexie";
import { RelayDatabase } from "./local-db.ts";
import { createWorkspaceRepository } from "./workspace-repository.ts";
import { createWorkspaceStore } from "../components/workspace/workspace-store.ts";
import { startOperationUploader } from "./operation-uploader.ts";
import { OperationUploadError, submittedOperation } from "./operation-upload-http.ts";
import { getSyncSnapshot } from "../components/workspace/sync-inspector-data.ts";
import { selectSyncState, getSyncStatusLabel } from "../components/workspace/sync-state.ts";
import { emptyPull } from "./sync-test-helpers.mjs";

async function setup(t) {
  const db = new RelayDatabase(`relay-upload-${crypto.randomUUID()}`);
  await db.open();
  const workspaceId = crypto.randomUUID(), stageId = crypto.randomUUID(), accountId = crypto.randomUUID();
  const repository = createWorkspaceRepository(async () => db);
  const seed = { workspace: { id: workspaceId, name: "Online", members: ["You"], source: "server", cachedForUserId: accountId },
    stages: { [stageId]: { id: stageId, name: "Ideas", description: "", version: 0 } }, items: {},
    stageOrder: [stageId], itemOrderByStage: { [stageId]: [] }, pendingOperations: [],
    syncMetadata: { workspaceId, localRevision: 0, lastServerVersion: 0, lastSyncedAt: null } };
  await repository.initializeServerWorkspace(seed);
  const store = createWorkspaceStore({ savedWorkspace: seed, repository });
  await store.persistence.initialize();
  const stops = [];
  t.after(async () => { stops.forEach((stop) => stop()); await new Promise((r) => setTimeout(r, 30)); await db.delete(); });
  const start = (options) => {
    const stop = startOperationUploader(store, { pull: emptyPull, lock: async (_name, run) => run(), verifyAccount: async () => true, ...options });
    stops.push(stop); return stop;
  };
  return { db, repository, store, stageId, workspaceId, seed, start };
}
async function until(check) {
  const deadline = Date.now() + 5000;
  while (!(await check())) {
    if (Date.now() > deadline) assert.fail("Timed out waiting for upload state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function ack(op, serverVersion) {
  return { operationId: op.id, workspaceId: op.workspaceId, entityId: op.entityId, status: "accepted", serverVersion,
    entityVersion: op.type === "CREATE_ITEM" ? 1 : op.baseVersion + 1 };
}

test("online/offline actions share a durable, ordered upload path with confirmed entity bases", async (t) => {
  const { store, repository, db, workspaceId, stageId, start } = await setup(t);
  store.setOnline(false);
  const item = store.actions.createItem("First", stageId);
  store.actions.updateItem(item.id, { title: "Edited" });
  store.actions.renameStage(stageId, "Ready");
  store.actions.renameStage(stageId, "Ready again");
  store.actions.deleteItem(item.id);
  const calls = [];
  let inFlight = 0, maxInFlight = 0;
  start({ submit: async (op) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
    assert.ok(await db.pendingOperations.get(op.id), "durable before submission");
    submittedOperation(op);
    calls.push(op);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--; return ack(op, calls.length);
  } });
  await store.persistence.flush();
  assert.equal(calls.length, 0);
  store.setOnline(true);
  await until(() => store.getSnapshot().pendingOperations.length === 0);
  assert.equal(maxInFlight, 1);
  assert.deepEqual(calls.map((op) => [op.type, op.baseVersion]), [
    ["CREATE_ITEM", null], ["UPDATE_ITEM", 1], ["RENAME_STAGE", 0], ["RENAME_STAGE", 1], ["DELETE_ITEM", 2],
  ]);
  const saved = await repository.getWorkspace(workspaceId);
  assert.equal(saved.syncMetadata.lastServerVersion, 5);
  assert.equal(saved.syncMetadata.localRevision, 5);
  assert.equal(saved.stages[stageId].version, 2);
  assert.equal(saved.syncMetadata.recentAcknowledgments.length, 5);
  assert.equal(await db.pendingOperations.count(), 0);
  assert.equal(saved.items[item.id], undefined);
  await until(() => store.getSnapshot().syncPhase === "synced");
  assert.match(getSyncStatusLabel(selectSyncState(store.getSnapshot())), /Synced with server/);
  assert.equal(getSyncSnapshot(store.getSnapshot()).activity.filter((a) => a.state === "confirmed").length, 5);
});

test("lost responses retain the exact ID/body across reload and retry", async (t) => {
  const { store, repository, stageId, workspaceId, seed, start } = await setup(t);
  store.actions.createItem("Once", stageId);
  let body;
  const stop = start({ submit: async (op) => { body = JSON.stringify(submittedOperation(op)); throw new Error("Response lost after commit"); } });
  await until(() => store.getSnapshot().syncMetadata.uploadFailure);
  stop();
  const saved = await repository.getWorkspace(workspaceId);
  assert.equal(saved.pendingOperations.length, 1);
  assert.equal(saved.syncMetadata.lastServerVersion, 0);
  const restored = createWorkspaceStore({ savedWorkspace: seed, repository });
  await restored.persistence.initialize();
  assert.equal(restored.getSnapshot().syncMetadata.uploadFailure.attempts, 1);
  await restored.upload.retry();
  const stopRestored = startOperationUploader(restored, { pull: emptyPull, lock: async (_name, run) => run(), verifyAccount: async () => true,
    submit: async (op) => { assert.equal(JSON.stringify(submittedOperation(op)), body); return ack(op, 1); } });
  t.after(stopRestored);
  await until(() => restored.getSnapshot().pendingOperations.length === 0);
  assert.equal((await repository.getWorkspace(workspaceId)).syncMetadata.lastServerVersion, 1);
});

test("permanent create rejection pauses dependent edits and remains visible after restoration", async (t) => {
  const { store, repository, stageId, workspaceId, seed, start } = await setup(t);
  const item = store.actions.createItem("Rejected", stageId);
  store.actions.updateItem(item.id, { description: "Depends on create" });
  let calls = 0;
  start({ submit: async () => { calls++; throw new OperationUploadError("validation", "INVALID_STAGE", "Stage was removed."); } });
  await until(() => store.getSnapshot().syncMetadata.uploadFailure);
  store.actions.renameStage(stageId, "Keep this too");
  await store.persistence.flush();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.equal((await repository.getWorkspace(workspaceId)).pendingOperations.length, 3);
  const restored = createWorkspaceStore({ savedWorkspace: seed, repository });
  await restored.persistence.initialize();
  assert.equal(restored.getSnapshot().syncMetadata.uploadFailure.code, "INVALID_STAGE");
  assert.equal(selectSyncState(restored.getSnapshot()).status, "failed");
  assert.match(getSyncSnapshot(restored.getSnapshot()).activity.find((a) => a.state === "failed").detail, /Stage was removed/);
});

test("acknowledgment rollback retains the queue, versions, entity and audit metadata together", async (t) => {
  const { store, repository, db, stageId, workspaceId } = await setup(t);
  const item = store.actions.createItem("Atomic", stageId);
  store.actions.updateItem(item.id, { title: "Keep optimistic title" });
  await store.persistence.flush();
  const before = await repository.getWorkspace(workspaceId);
  const fail = () => { throw new DOMException("Quota", "QuotaExceededError"); };
  db.workspaceSyncMetadata.hook("updating", fail);
  await assert.rejects(repository.acknowledge(before.pendingOperations[0], ack(before.pendingOperations[0], 1)), { name: "QuotaExceededError" });
  assert.deepEqual(await repository.getWorkspace(workspaceId), before);
  db.workspaceSyncMetadata.hook("updating").unsubscribe(fail);
  await store.upload.acknowledge(before.pendingOperations[0], ack(before.pendingOperations[0], 1));
  assert.equal(store.getSnapshot().items[item.id].title, "Keep optimistic title");
  assert.equal(store.getSnapshot().pendingOperations.length, 1);
});

test("edits made while a request is in flight keep their fields and advance only after our own acknowledgment", async (t) => {
  const { store, repository, stageId, workspaceId, start } = await setup(t);
  const item = store.actions.createItem("Original", stageId);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  start({ submit: async (op) => {
    calls.push(op);
    if (calls.length === 1) await gate;
    return ack(op, calls.length);
  } });
  await until(() => calls.length === 1);
  store.actions.updateItem(item.id, { title: "Changed during request" });
  store.actions.updateItem(item.id, { description: "Second queued edit" });
  release();
  await until(() => store.getSnapshot().pendingOperations.length === 0);
  assert.deepEqual(calls.map((op) => op.baseVersion), [null, 1, 2]);
  const saved = await repository.getWorkspace(workspaceId);
  assert.equal(saved.items[item.id].title, "Changed during request");
  assert.equal(saved.items[item.id].description, "Second queued edit");
  assert.equal(saved.items[item.id].version, 3);
});

test("mismatched acknowledgments never remove work or advance confirmed versions", async (t) => {
  const { store, stageId, start } = await setup(t);
  store.actions.createItem("Keep me", stageId);
  start({ submit: async (op) => ({ ...ack(op, 1), operationId: crypto.randomUUID() }) });
  await until(() => store.getSnapshot().syncMetadata.uploadFailure);
  assert.equal(store.getSnapshot().syncMetadata.uploadFailure.code, "INVALID_ACKNOWLEDGMENT");
  assert.equal(store.getSnapshot().pendingOperations.length, 1);
  assert.equal(store.getSnapshot().syncMetadata.lastServerVersion, 0);
});

test("account changes stop submission and preserve the owning account's queue", async (t) => {
  const { store, stageId, start } = await setup(t);
  store.actions.createItem("Private edit", stageId);
  let calls = 0;
  start({ verifyAccount: async () => false, submit: async () => { calls++; throw new Error("Must not send"); } });
  await until(() => store.getSnapshot().syncMetadata.uploadFailure);
  assert.equal(calls, 0);
  assert.equal(store.getSnapshot().syncMetadata.uploadFailure.kind, "authorization");
  assert.equal(store.getSnapshot().pendingOperations.length, 1);
});

test("unversioned legacy stage renames are preserved for recovery without guessing a server base", async (t) => {
  const { store, db, repository, stageId, workspaceId } = await setup(t);
  store.actions.renameStage(stageId, "Legacy rename");
  await store.persistence.flush();
  const [op] = (await repository.getWorkspace(workspaceId)).pendingOperations;
  await db.pendingOperations.update(op.id, { baseVersion: null });
  const [legacy] = (await repository.getWorkspace(workspaceId)).pendingOperations;
  assert.throws(() => submittedOperation(legacy), /no server base version/);
  assert.equal(await db.pendingOperations.count(), 1);
});

test("pre-ingestion server caches migrate the known zero baseline without rewriting local work", async (t) => {
  const name = `relay-stage-upgrade-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(2).stores({ workspaces: "id", workflowStages: "[workspaceId+id], workspaceId",
    workItems: "[workspaceId+id], workspaceId, [workspaceId+stageId]",
    pendingOperations: "id, workspaceId, &[workspaceId+sequence]", workspaceSyncMetadata: "workspaceId" });
  await old.open();
  const workspaceId = crypto.randomUUID(), stageId = crypto.randomUUID();
  const operation = { id: crypto.randomUUID(), workspaceId, entityId: stageId, type: "RENAME_STAGE",
    baseVersion: null, timestamp: new Date().toISOString(), payload: { name: "Offline name" }, sequence: 3 };
  await old.table("workspaces").put({ id: workspaceId, name: "Legacy server", source: "server", cachedForUserId: crypto.randomUUID(),
    members: ["You"], stageOrder: [stageId], itemOrderByStage: { [stageId]: [] } });
  await old.table("workflowStages").put({ workspaceId, id: stageId, name: "Offline name", description: "Original description" });
  await old.table("pendingOperations").put(operation);
  const metadata = { workspaceId, localRevision: 3, lastServerVersion: 0, lastSyncedAt: null };
  await old.table("workspaceSyncMetadata").put(metadata);
  old.close();
  const db = new RelayDatabase(name);
  t.after(() => db.delete());
  await db.open();
  assert.deepEqual(await db.pendingOperations.get(operation.id), { ...operation, baseVersion: 0 });
  assert.deepEqual(await db.workspaceSyncMetadata.get(workspaceId), metadata);
  assert.deepEqual(await db.workflowStages.get([workspaceId, stageId]), {
    workspaceId, id: stageId, name: "Offline name", description: "Original description", version: 0,
  });
});

test("temporary failures stop automatic retry after five attempts", async (t) => {
  const { store, repository, stageId, workspaceId, start } = await setup(t);
  store.actions.createItem("Retry bound", stageId);
  await store.persistence.flush();
  const operationId = store.getSnapshot().pendingOperations[0].id;
  await repository.setUploadFailure(workspaceId, { operationId, kind: "temporary", code: "SERVER_UNAVAILABLE",
    message: "Unavailable", attempts: 4, retryAt: new Date(Date.now() - 1000).toISOString() });
  let calls = 0;
  start({ submit: async () => { calls++; throw new Error("Still unavailable"); } });
  await until(() => store.getSnapshot().syncMetadata.uploadFailure?.attempts === 5);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 1);
  assert.equal(store.getSnapshot().syncMetadata.uploadFailure.retryAt, null);
  assert.equal(store.getSnapshot().pendingOperations[0].id, operationId);
});

test("two tabs share one upload lock and incorporate the same durable acknowledgment", async (t) => {
  const { store, repository, seed, stageId, start } = await setup(t);
  store.actions.createItem("One in flight", stageId);
  await store.persistence.flush();
  const other = createWorkspaceStore({ savedWorkspace: seed, repository });
  await other.persistence.initialize();
  let held = false, calls = 0, release;
  const names = new Set();
  const gate = new Promise((resolve) => { release = resolve; });
  const options = {
    pull: emptyPull,
    lock: async (name, run) => { names.add(name); if (held) return; held = true; try { await run(); } finally { held = false; } },
    verifyAccount: async () => true,
    submit: async (op) => { calls++; await gate; return ack(op, 1); },
  };
  start(options);
  const stopOther = startOperationUploader(other, options);
  t.after(stopOther);
  await until(() => calls === 1);
  release();
  await until(() => store.getSnapshot().pendingOperations.length === 0 && other.getSnapshot().pendingOperations.length === 0);
  assert.equal(calls, 1);
  assert.equal(names.size, 1);
  assert.equal(other.getSnapshot().syncMetadata.lastServerVersion, 1);
});
