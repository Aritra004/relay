import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayDatabase } from "./local-db.ts";
import { createWorkspaceRepository } from "./workspace-repository.ts";
import {
  createWorkspaceStore,
  selectBoard,
} from "../components/workspace/workspace-store.ts";

async function setup(t) {
  const db = new RelayDatabase(`relay-repository-test-${crypto.randomUUID()}`);
  await db.open();
  t.after(() => db.delete());
  const repository = createWorkspaceRepository(async () => db);
  return { db, repository };
}

function createStore(repository, id = "workspace-a") {
  // These tests exercise the explicit snapshot repository independently of
  // automatic store persistence (covered by workspace-persistence.test.mjs).
  const store = createWorkspaceStore({
    repository: null,
    workspace: { id, name: id, members: ["You"] },
  });
  return { ...store, persistence: {
    initialize: () => repository.initialize(),
    save: (syncMetadata) => repository.saveWorkspace({ ...store.getSnapshot(), syncMetadata }),
    read: () => repository.getWorkspace(id),
  } };
}

function durableSnapshot(state) {
  return {
    workspace: state.workspace,
    stages: state.stages,
    items: state.items,
    stageOrder: state.stageOrder,
    itemOrderByStage: state.itemOrderByStage,
    pendingOperations: state.pendingOperations,
  };
}

test("a complete workspace round-trips through a new repository without React", async (t) => {
  const { db, repository } = await setup(t);
  const store = createStore(repository);
  const item = store.actions.createItem("Offline task", "planned");
  store.actions.updateItem(item.id, { title: "Edited task", description: "Keep this" });
  store.actions.moveItem({ itemId: item.id, stageId: "idea", beforeItemId: "RLY-018" });
  store.actions.renameStage("planned", "Ready");
  store.actions.deleteItem("RLY-019");
  store.selectItem(item.id);
  store.setOnline(false);
  const snapshot = store.getSnapshot();
  const syncMetadata = {
    workspaceId: snapshot.workspace.id,
    localRevision: 0, lastServerVersion: 8,
    lastSyncedAt: "2026-09-21T10:00:00.000Z",
  };

  await store.persistence.initialize();
  await store.persistence.save(syncMetadata);
  db.close();
  await db.open();
  const freshRepository = createWorkspaceRepository(async () => db);
  const saved = await freshRepository.getWorkspace(snapshot.workspace.id);
  assert.deepEqual(saved, { ...durableSnapshot(snapshot), syncMetadata });
  assert.deepEqual(selectBoard(saved), selectBoard(snapshot));
  assert.equal(store.getSnapshot(), snapshot, "saving must not publish or acknowledge edits");
  assert.equal("selectedItemId" in saved, false);
  assert.equal("syncStatus" in saved, false);
  assert.equal("lastOperation" in saved, false);
  assert.equal("sequence" in saved.pendingOperations[0], false);
  assert.equal("workspaceId" in saved.items[item.id], false);
  assert.equal("workspaceId" in saved.stages.planned, false);
  const storedWorkspace = await db.workspaces.get(snapshot.workspace.id);
  assert.equal("selectedItemId" in storedWorkspace, false);
  assert.equal("pendingOperations" in storedWorkspace, false);
});

test("store saves and reads are explicit and never overwrite live edits", async (t) => {
  const { repository } = await setup(t);
  const store = createStore(repository);
  assert.equal(await store.persistence.read(), undefined);
  await store.persistence.save();
  const original = await store.persistence.read();
  store.actions.updateItem("RLY-014", { title: "Unsaved edit" });
  assert.deepEqual(await store.persistence.read(), original);
  assert.equal(store.getSnapshot().items["RLY-014"].title, "Unsaved edit");
  await store.persistence.save();
  const saved = await store.persistence.read();
  assert.equal(saved.items["RLY-014"].title, "Unsaved edit");
  saved.items["RLY-014"].title = "Only a returned copy";
  assert.equal((await store.persistence.read()).items["RLY-014"].title, "Unsaved edit");
});

test("replacing a workspace removes stale items and queue entries without touching another workspace", async (t) => {
  const { repository, db } = await setup(t);
  const a = createStore(repository, "a");
  const b = createStore(repository, "b");
  a.actions.updateItem("RLY-014", { title: "Earlier edit" });
  b.actions.updateItem("RLY-014", { title: "Other workspace" });
  await a.persistence.save();
  await b.persistence.save({ workspaceId: "b", localRevision: 0, lastServerVersion: 2, lastSyncedAt: null });
  const savedB = await b.persistence.read();
  a.actions.deleteItem("RLY-014");
  a.actions.renameStage("planned", "Renamed locally");
  const replacement = durableSnapshot(a.getSnapshot());
  // Explicit replacement of a queue, such as after acknowledgements are handled.
  replacement.pendingOperations = [];
  await repository.saveWorkspace(replacement);
  assert.deepEqual(await a.persistence.read(), { ...replacement, syncMetadata: null });
  assert.equal(await db.workItems.get(["a", "RLY-014"]), undefined);
  assert.equal(await db.pendingOperations.where({ workspaceId: "a" }).count(), 0);
  assert.deepEqual(await b.persistence.read(), savedB);
});

test("pending operation array order survives equal or reversed timestamps and IDs", async (t) => {
  const { repository } = await setup(t);
  const store = createStore(repository);
  store.actions.renameStage("planned", "First");
  store.actions.renameStage("planned", "Second");
  store.actions.renameStage("planned", "Third");
  const snapshot = durableSnapshot(store.getSnapshot());
  snapshot.pendingOperations = snapshot.pendingOperations.map((operation, index) => ({
    ...operation,
    id: ["z", "a", "m"][index],
    timestamp: index === 0 ? "2026-09-22T10:00:00.000Z" : "2026-09-21T10:00:00.000Z",
  }));
  await repository.saveWorkspace(snapshot);
  assert.deepEqual((await repository.getWorkspace(snapshot.workspace.id)).pendingOperations, snapshot.pendingOperations);
});

test("metadata can be updated independently, preserved on save, or explicitly cleared", async (t) => {
  const { repository } = await setup(t);
  const store = createStore(repository);
  assert.equal(await repository.getSyncMetadata("missing"), undefined);
  await assert.rejects(
    repository.saveSyncMetadata({ workspaceId: "missing", localRevision: 0, lastServerVersion: 1, lastSyncedAt: null }),
    /missing workspace/,
  );
  await store.persistence.save();
  const before = await store.persistence.read();
  const metadata = { workspaceId: "workspace-a", localRevision: 0, lastServerVersion: 12, lastSyncedAt: null };
  await repository.saveSyncMetadata(metadata);
  assert.deepEqual(await repository.getSyncMetadata("workspace-a"), metadata);
  assert.deepEqual(await store.persistence.read(), { ...before, syncMetadata: metadata });
  await store.persistence.save();
  assert.deepEqual(await repository.getSyncMetadata("workspace-a"), metadata);
  await store.persistence.save(null);
  assert.equal(await repository.getSyncMetadata("workspace-a"), undefined);
});

test("foreign ownership, duplicate operations, and broken ordering reject without changing saved data", async (t) => {
  const { repository } = await setup(t);
  const store = createStore(repository);
  store.actions.renameStage("planned", "Ready");
  await store.persistence.save();
  const before = await store.persistence.read();
  const malformed = [
    { ...before, syncMetadata: { workspaceId: "another", localRevision: 0, lastServerVersion: 1, lastSyncedAt: null } },
    { ...before, pendingOperations: [{ ...before.pendingOperations[0], workspaceId: "another" }] },
    { ...before, pendingOperations: [before.pendingOperations[0], before.pendingOperations[0]] },
    { ...before, stageOrder: [...before.stageOrder, before.stageOrder[0]] },
    { ...before, itemOrderByStage: { ...before.itemOrderByStage, planned: [] } },
  ];
  for (const snapshot of malformed) {
    await assert.rejects(repository.saveWorkspace(snapshot));
    assert.deepEqual(await store.persistence.read(), before);
  }
});

test("a mid-transaction failure rolls back entity replacement and preserves both workspaces", async (t) => {
  const { repository } = await setup(t);
  const a = createStore(repository, "a");
  const b = createStore(repository, "b");
  a.actions.renameStage("planned", "Saved stage");
  b.actions.renameStage("planned", "Other stage");
  await a.persistence.save();
  await b.persistence.save();
  const beforeA = await a.persistence.read();
  const beforeB = await b.persistence.read();
  a.actions.deleteItem("RLY-014");
  const replacement = durableSnapshot(a.getSnapshot());
  replacement.pendingOperations = [{
    ...replacement.pendingOperations[0],
    id: beforeB.pendingOperations[0].id,
  }];
  // The ID belongs to B. Failure occurs after A's existing rows were deleted,
  // proving the transaction restores the entire old snapshot on a write error.
  await assert.rejects(repository.saveWorkspace(replacement), { name: "BulkError" });
  assert.deepEqual(await a.persistence.read(), beforeA);
  assert.deepEqual(await b.persistence.read(), beforeB);
});

test("save captures its input before waiting for the database", async (t) => {
  const { db, repository } = await setup(t);
  let release;
  const delayed = new Promise((resolve) => { release = resolve; });
  const slowRepository = createWorkspaceRepository(() => delayed);
  const snapshot = structuredClone(durableSnapshot(createStore(repository).getSnapshot()));
  const expected = structuredClone(snapshot);
  const writing = slowRepository.saveWorkspace(snapshot);
  snapshot.workspace.name = "Changed after save started";
  snapshot.items["RLY-014"].title = "Changed while awaiting storage";
  release(db);
  await writing;
  assert.deepEqual(await repository.getWorkspace(expected.workspace.id), { ...expected, syncMetadata: null });
});

test("storage failures propagate through explicit store methods", async () => {
  const failure = new Error("Storage unavailable");
  const repository = createWorkspaceRepository(async () => { throw failure; });
  const store = createStore(repository);
  await assert.rejects(store.persistence.initialize(), (error) => error === failure);
  await assert.rejects(store.persistence.save(), (error) => error === failure);
  await assert.rejects(store.persistence.read(), (error) => error === failure);
});
