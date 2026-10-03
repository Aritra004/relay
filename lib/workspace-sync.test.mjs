import assert from "node:assert/strict";
import { test } from "node:test";
import { syncFixture, until } from "./sync-test-helpers.mjs";
import { createWorkspaceStore } from "../components/workspace/workspace-store.ts";
import { OperationUploadError } from "./operation-upload-http.ts";
import { validateHistory } from "./sync-http.ts";
import { classifyRemoteOperation } from "./sync-replay.ts";
import { transitionSyncPhase } from "./sync-contract.ts";
import { getSyncSnapshot } from "../components/workspace/sync-inspector-data.ts";

test("pulls paginated history before any push, preserving local optimistic work", async (t) => {
  const f = await syncFixture(t);
  f.store.actions.createItem("Offline intent", f.stageId);
  const localId = f.store.getSnapshot().pendingOperations[0].entityId;
  for (let i = 0; i < 5; i++) f.accept(f.create(`Other ${i}`), crypto.randomUUID());
  f.batch(2);
  const phases = new Set();
  f.store.subscribe(() => phases.add(f.store.getSnapshot().syncPhase));
  f.start({ submit: async (op, ...args) => {
    assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 5);
    assert.equal(f.store.getSnapshot().items[localId].title, "Offline intent");
    return f.options.submit(op, ...args);
  } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.deepEqual(f.events.slice(0, 3), ["pull:0", "pull:2", "pull:4"]);
  assert.equal(Object.keys(f.store.getSnapshot().items).length, 6);
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 6);
  assert.deepEqual([...phases], ["idle", "checking", "pulling", "applying-remote", "pushing-local", "synced"]);
  const inspector = getSyncSnapshot(f.store.getSnapshot());
  assert.equal(inspector.serverVersion, 6);
  assert.equal(inspector.currentServerVersion, 6);
  assert.equal(inspector.receivedRemoteOperations, 5);
  assert.equal(inspector.connection, "Online");
});

test("remote stage move and offline title edit merge using the same domain applier", async (t) => {
  const f = await syncFixture(t), create = f.create();
  const created = f.accept(create);
  await f.store.sync.apply(created, 1);
  f.store.actions.updateItem(create.entityId, { title: "Offline title" });
  const move = f.operation("MOVE_ITEM", create.entityId, { stageId: f.otherStage, beforeItemId: null });
  f.accept(move, crypto.randomUUID());
  f.start({ submit: async (op, ...args) => {
    assert.equal(op.baseVersion, 2);
    assert.equal(f.store.getSnapshot().items[create.entityId].title, "Offline title");
    assert.equal(f.store.getSnapshot().items[create.entityId].stageId, f.otherStage);
    return f.options.submit(op, ...args);
  } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[create.entityId].title, "Offline title");
  assert.deepEqual(f.store.getSnapshot().itemOrderByStage, f.server().itemOrderByStage);
});

test("same-field remote edit stops at a durable conflict without dropping either intent", async (t) => {
  const f = await syncFixture(t), create = f.create();
  await f.store.sync.apply(f.accept(create), 1);
  f.store.actions.updateItem(create.entityId, { title: "Local title" });
  f.accept(f.operation("UPDATE_ITEM", create.entityId, { title: "Remote title" }), crypto.randomUUID());
  f.start({ submit: async () => assert.fail("Must not push a conflict") });
  await until(() => f.store.getSnapshot().syncPhase === "conflict");
  await f.store.upload.retry();
  const saved = await f.repository.getWorkspace(f.workspaceId);
  assert.equal(saved.items[create.entityId].title, "Local title");
  assert.equal(saved.syncMetadata.confirmedServerVersion, 2);
  assert.equal(saved.syncMetadata.conflicts[0].serverValues.title, "Remote title");
  assert.equal(saved.pendingOperations.length, 1);
  assert.equal(saved.syncMetadata.uploadFailure ?? null, null);
});

test("entity, confirmed base and cursor roll back together if the IndexedDB commit fails", async (t) => {
  const f = await syncFixture(t);
  const remote = f.accept(f.create());
  const before = await f.repository.getWorkspace(f.workspaceId);
  const base = await f.db.confirmedWorkspaces.get(f.workspaceId);
  const fail = () => { throw new DOMException("Quota", "QuotaExceededError"); };
  f.db.workspaceSyncMetadata.hook("updating", fail);
  await assert.rejects(f.store.sync.apply(remote, 1), { name: "QuotaExceededError" });
  f.db.workspaceSyncMetadata.hook("updating").unsubscribe(fail);
  assert.deepEqual(await f.repository.getWorkspace(f.workspaceId), before);
  assert.deepEqual(await f.db.confirmedWorkspaces.get(f.workspaceId), base);
  await f.store.sync.apply(remote, 1);
  await f.store.sync.apply(remote, 1); // duplicate delivery
  f.db.close(); await f.db.open();
  assert.equal((await f.repository.getWorkspace(f.workspaceId)).syncMetadata.confirmedServerVersion, 1);
  assert.equal((await f.repository.getWorkspace(f.workspaceId)).syncMetadata.receivedRemoteOperations, 1);
});

test("acknowledgment version gaps pull intervening changes and converge after the final upload", async (t) => {
  const f = await syncFixture(t);
  f.store.actions.createItem("Local", f.stageId);
  f.start({ submit: async (op) => {
    f.accept(f.create("Racing writer"), crypto.randomUUID());
    const ack = f.ack(f.accept(op));
    f.accept(f.create("After acknowledgment"), crypto.randomUUID());
    return ack;
  } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 3);
  assert.equal(Object.keys(f.store.getSnapshot().items).length, 3);
  assert.equal(f.store.getSnapshot().pendingOperations.length, 0);
});

test("ten pending operations resume with six after four acknowledgments and a disconnect", async (t) => {
  const f = await syncFixture(t);
  for (let i = 0; i < 10; i++) f.store.actions.createItem(`Local ${i}`, f.stageId);
  let calls = 0;
  const stop = f.start({ submit: async (op) => {
    calls++;
    if (calls === 5) { f.store.setOnline(false); throw new TypeError("Connection lost"); }
    return f.ack(f.accept(op));
  } });
  await until(() => f.store.getSnapshot().syncPhase === "offline");
  stop();
  const saved = await f.repository.getWorkspace(f.workspaceId);
  assert.equal(saved.pendingOperations.length, 6);
  assert.equal(saved.syncMetadata.confirmedServerVersion, 4);
  const restored = createWorkspaceStore({ savedWorkspace: saved, repository: f.repository });
  await restored.persistence.initialize();
  f.start({}, restored);
  await until(() => restored.getSnapshot().syncPhase === "synced");
  assert.equal(f.log.length, 10);
  assert.equal(new Set(f.log.map((row) => row.operation.id)).size, 10);
  assert.equal(restored.getSnapshot().pendingOperations.length, 0);
});

test("lost-response retry discovers its own operation while pulling and never resubmits it", async (t) => {
  const f = await syncFixture(t);
  f.store.actions.createItem("Exactly once", f.stageId);
  let calls = 0;
  f.start({ submit: async (op) => { calls++; f.accept(op); throw new TypeError("Reply lost"); } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(calls, 1);
  assert.equal(f.log.length, 1);
});

test("snapshot recovery preserves a compatible pending update and resumes", async (t) => {
  const f = await syncFixture(t), original = f.create();
  await f.store.sync.apply(f.accept(original), 1);
  f.store.actions.updateItem(original.entityId, { title: "Preserved title" });
  f.accept(f.create("Missing history"), crypto.randomUUID());
  f.pruneBefore(2);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[original.entityId].title, "Preserved title");
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 3);
});

test("snapshot with a remotely deleted pending target preserves the optimistic board and queue", async (t) => {
  const f = await syncFixture(t), original = f.create();
  await f.store.sync.apply(f.accept(original), 1);
  f.store.actions.updateItem(original.entityId, { title: "Unsynced work" });
  f.accept(f.operation("DELETE_ITEM", original.entityId, null), crypto.randomUUID());
  f.pruneBefore(2);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "conflict");
  assert.equal(f.store.getSnapshot().items[original.entityId].title, "Unsynced work");
  assert.equal(f.store.getSnapshot().pendingOperations.length, 1);
  assert.equal((await f.db.confirmedWorkspaces.get(f.workspaceId)).items[original.entityId], undefined);
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 2);
});

test("snapshot recovery recognizes a lost acknowledged create through its receipt", async (t) => {
  const f = await syncFixture(t);
  const item = f.store.actions.createItem("Created offline", f.stageId);
  f.store.actions.updateItem(item.id, { title: "Later local edit" });
  await f.store.persistence.flush();
  f.accept(f.store.getSnapshot().pendingOperations[0]);
  f.pruneBefore(1);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.log.length, 2);
  assert.equal(f.server().items[item.id].title, "Later local edit");
});

test("edits made while a pull is in flight survive projection and catch-up", async (t) => {
  const f = await syncFixture(t), original = f.create();
  await f.store.sync.apply(f.accept(original), 1);
  f.accept(f.operation("MOVE_ITEM", original.entityId, { stageId: f.otherStage, beforeItemId: null }), crypto.randomUUID());
  let once = false;
  f.start({ pull: async (...args) => {
    const page = await f.options.pull(...args);
    if (!once) { once = true; f.store.actions.updateItem(original.entityId, { title: "Typed during pull" }); }
    return page;
  } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[original.entityId].title, "Typed during pull");
  assert.equal(f.server().items[original.entityId].stageId, f.otherStage);
});

test("pull failures retry without a pending queue; permanent failures remain stopped", async (t) => {
  const f = await syncFixture(t);
  let calls = 0;
  f.start({ pull: async (...args) => { if (++calls < 3) throw new TypeError("Timeout"); return f.options.pull(...args); } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(calls, 3);
  assert.ok(f.store.getSnapshot().syncMetadata.lastSyncedAt);
  const other = await syncFixture(t);
  let denied = 0;
  other.start({ pull: async () => { denied++; throw new OperationUploadError("authorization", "FORBIDDEN", "Access revoked."); } });
  await until(() => other.store.getSnapshot().syncPhase === "error");
  other.store.sync.request();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(denied, 1);
});

test("invalid order and illegal state transitions are rejected; field and anchor conflicts are classified", async (t) => {
  const f = await syncFixture(t), create = f.create();
  const remote = f.accept(create);
  assert.throws(() => validateHistory({ status: "ok", workspaceId: f.workspaceId, startingVersion: 0, endingVersion: 2,
    currentWorkspaceVersion: 2, hasMore: false, operations: [{ ...remote, serverVersion: 2 }] }, f.workspaceId, 0));
  assert.throws(() => transitionSyncPhase("idle", "synced"));
  const title = f.operation("UPDATE_ITEM", create.entityId, { title: "Title" });
  const description = f.operation("UPDATE_ITEM", create.entityId, { description: "Description" });
  assert.equal(classifyRemoteOperation(title, description), "safe");
  const move = f.operation("MOVE_ITEM", crypto.randomUUID(), { stageId: f.stageId, beforeItemId: create.entityId });
  assert.equal(classifyRemoteOperation(f.operation("DELETE_ITEM", create.entityId, null), move), "conflict");
});

test("a local edit during the remote IndexedDB transaction preserves compatible work", async (t) => {
  const f = await syncFixture(t), create = f.create();
  await f.store.sync.apply(f.accept(create), 1);
  const move = f.accept(f.operation("MOVE_ITEM", create.entityId, { stageId: f.otherStage, beforeItemId: null }), crypto.randomUUID());
  let once = false;
  const typeDuringCommit = () => { if (!once) { once = true; f.store.actions.updateItem(create.entityId, { title: "During commit" }); } };
  f.db.workspaceSyncMetadata.hook("updating", typeDuringCommit);
  await f.store.sync.apply(move, 2);
  await f.store.persistence.flush();
  f.db.workspaceSyncMetadata.hook("updating").unsubscribe(typeDuringCommit);
  const saved = await f.repository.getWorkspace(f.workspaceId);
  assert.equal(saved.items[create.entityId].title, "During commit");
  assert.equal(saved.items[create.entityId].stageId, f.otherStage);
  assert.equal(saved.pendingOperations[0].baseVersion, 2);
  assert.equal(saved.syncMetadata.syncConflict ?? null, null);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
});

test("a same-field edit during a remote transaction is retained as a conflict", async (t) => {
  const f = await syncFixture(t), create = f.create();
  await f.store.sync.apply(f.accept(create), 1);
  const remote = f.accept(f.operation("UPDATE_ITEM", create.entityId, { title: "Remote title" }), crypto.randomUUID());
  let once = false;
  const typeDuringCommit = () => { if (!once) { once = true; f.store.actions.updateItem(create.entityId, { title: "Concurrent local title" }); } };
  f.db.workspaceSyncMetadata.hook("updating", typeDuringCommit);
  await f.store.sync.apply(remote, 2);
  await f.store.persistence.flush();
  f.db.workspaceSyncMetadata.hook("updating").unsubscribe(typeDuringCommit);
  const saved = await f.repository.getWorkspace(f.workspaceId);
  assert.equal(saved.items[create.entityId].title, "Concurrent local title");
  assert.equal(saved.pendingOperations[0].baseVersion, 1);
  assert.ok(saved.syncMetadata.syncConflict);
  assert.ok(f.store.getSnapshot().syncMetadata.syncConflict);
  assert.equal((await f.db.confirmedWorkspaces.get(f.workspaceId)).items[create.entityId].title, "Remote title");
});

test("a writer racing a submission is pulled and classified after a stale rejection", async (t) => {
  const f = await syncFixture(t), create = f.create();
  await f.store.sync.apply(f.accept(create), 1);
  f.store.actions.updateItem(create.entityId, { title: "Local title" });
  let calls = 0;
  f.start({ submit: async (op) => {
    if (++calls === 1) f.accept(f.operation("MOVE_ITEM", create.entityId, { stageId: f.otherStage, beforeItemId: null }), crypto.randomUUID());
    return f.ack(f.accept(op));
  } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(calls, 1);
  assert.equal(f.server().items[create.entityId].title, "Local title");
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 3);
});

test("snapshot recovery merges an anchor title edit without blocking a move", async (t) => {
  const f = await syncFixture(t), item = f.create("Moving"), anchor = f.create("Anchor", f.otherStage);
  await f.store.sync.apply(f.accept(item), 1);
  await f.store.sync.apply(f.accept(anchor), 2);
  f.store.actions.moveItem({ itemId: item.entityId, stageId: f.otherStage, beforeItemId: anchor.entityId });
  f.accept(f.operation("UPDATE_ITEM", anchor.entityId, { title: "Changed anchor" }), crypto.randomUUID());
  f.pruneBefore(3);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.store.getSnapshot().syncMetadata.syncConflict, null);
  assert.equal(f.store.getSnapshot().pendingOperations.length, 0);
});

test("a legacy upload high-water mark never becomes a contiguous download cursor", async (t) => {
  const f = await syncFixture(t);
  f.store.actions.createItem("Legacy unsynced work", f.stageId);
  await f.store.persistence.flush();
  f.accept(f.create("Previously missed remote item"), crypto.randomUUID());
  const metadata = await f.repository.getSyncMetadata(f.workspaceId);
  delete metadata.confirmedServerVersion;
  delete metadata.currentServerVersion;
  metadata.lastServerVersion = 1;
  await f.db.workspaceSyncMetadata.put(metadata);
  await f.db.confirmedWorkspaces.delete(f.workspaceId);
  let snapshots = 0;
  f.start({ snapshot: async (...args) => { snapshots++; return f.options.snapshot(...args); } });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(snapshots, 1);
  assert.deepEqual(Object.values(f.store.getSnapshot().items).map((item) => item.title).sort(),
    ["Legacy unsynced work", "Previously missed remote item"]);
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 2);
});
