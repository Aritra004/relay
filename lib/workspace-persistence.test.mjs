import "fake-indexeddb/auto";
import { Dexie } from "dexie";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayDatabase } from "./local-db.ts";
import { createWorkspaceRepository } from "./workspace-repository.ts";
import { createWorkspaceStore, selectBoard } from "../components/workspace/workspace-store.ts";
import { getSyncSnapshot } from "../components/workspace/sync-inspector-data.ts";
import { selectSyncState } from "../components/workspace/sync-state.ts";

async function setup(t) {
  const db = new RelayDatabase(`relay-persistence-${crypto.randomUUID()}`);
  await db.open();
  t.after(() => db.delete());
  const repository = createWorkspaceRepository(async () => db);
  return { db, repository, store: createWorkspaceStore({ repository }) };
}

test("startup gates all mutations; concurrent first visits seed exactly once", async (t) => {
  const { db, repository, store } = await setup(t);
  assert.equal(store.getSnapshot().restoration, "loading");
  assert.equal(store.actions.createItem("Too early", "idea"), undefined);
  assert.equal(store.actions.updateItem("RLY-014", { title: "Too early" }), false);
  assert.equal(store.actions.deleteItem("RLY-014"), false);
  assert.equal(store.actions.moveItem({ itemId: "RLY-014", direction: "right" }), false);
  assert.equal(store.actions.renameStage("planned", "Too early"), false);
  const other = createWorkspaceStore({ repository });
  await Promise.all([store.persistence.initialize(), store.persistence.initialize(), other.persistence.initialize()]);
  assert.equal(store.getSnapshot().restoration, "ready");
  assert.equal(await db.workflowStages.count(), 5);
  assert.equal(await db.workspaces.count(), 1);
  assert.equal(await db.pendingOperations.count(), 0);
});

test("all five offline mutations and the same queue survive reopening without replay or reseeding", async (t) => {
  const { db, repository, store } = await setup(t);
  await store.persistence.initialize();
  store.setOnline(false);
  const created = store.actions.createItem("Offline item", "planned");
  store.actions.updateItem(created.id, { title: "Final title", description: "Keep this exact content" });
  store.actions.moveItem({ itemId: created.id, stageId: "idea", beforeItemId: "RLY-018" });
  store.actions.renameStage("planned", "Ready");
  store.actions.deleteItem("RLY-019");
  const optimistic = store.getSnapshot();
  assert.equal(optimistic.pendingOperations.length, 5);
  assert.equal(optimistic.unsavedOperationCount, 5);
  assert.equal(optimistic.persistedLocalRevision, 0);
  assert.equal(selectSyncState(optimistic).status, "saving");
  await store.persistence.flush();
  const before = store.getSnapshot();
  const persistedQueue = await db.pendingOperations.toCollection().sortBy("sequence");
  db.close();
  await db.open();
  for (let visit = 0; visit < 3; visit++) {
    const restored = createWorkspaceStore({ repository });
    restored.setOnline(false);
    await restored.persistence.initialize();
    const after = restored.getSnapshot();
    assert.deepEqual(selectBoard(after), selectBoard(before));
    assert.deepEqual(after.pendingOperations, before.pendingOperations);
    assert.deepEqual(await db.pendingOperations.toCollection().sortBy("sequence"), persistedQueue);
    assert.equal(after.items["RLY-019"], undefined);
    assert.equal(await db.workflowStages.count(), 5);
    assert.equal(after.persistedLocalRevision, 5);
    assert.equal(after.syncMetadata.lastServerVersion, null);
    assert.equal(after.unsavedOperationCount, 0);
    assert.deepEqual(getSyncSnapshot(after), getSyncSnapshot(before));
  }
});

test("a slow restoration does not allow operations and keeps the actual network state", async (t) => {
  const { repository } = await setup(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const store = createWorkspaceStore({ repository: { ...repository,
    restoreOrSeed: async (seed) => { await gate; return repository.restoreOrSeed(seed); },
  } });
  const restoring = store.persistence.initialize();
  store.setOnline(false);
  assert.equal(store.actions.renameStage("idea", "Do not queue"), false);
  release();
  await restoring;
  assert.equal(store.getSnapshot().syncStatus, "offline");
  assert.equal(store.getSnapshot().pendingOperations.length, 0);
});

test("quota failure rolls back the entity and revision, preserves unsaved work, and retries the same IDs", async (t) => {
  const { db, repository, store } = await setup(t);
  await store.persistence.initialize();
  store.actions.renameStage("idea", "Committed");
  await store.persistence.flush();
  const before = await repository.getWorkspace("product-workspace");
  const fail = () => { throw new DOMException("Test quota", "QuotaExceededError"); };
  db.pendingOperations.hook("creating", fail);
  const item = store.actions.createItem("Retain my work", "planned");
  store.actions.updateItem(item.id, { description: "Retain the second edit too" });
  const operations = store.getSnapshot().pendingOperations;
  await assert.rejects(store.persistence.flush(), { name: "QuotaExceededError" });
  assert.deepEqual(await repository.getWorkspace("product-workspace"), before);
  const failed = store.getSnapshot();
  assert.match(failed.storageError, /storage is full/);
  assert.equal(failed.unsavedOperationCount, 2);
  assert.equal(failed.persistedLocalRevision, 1);
  assert.equal(failed.items[item.id].description, "Retain the second edit too");
  assert.equal(selectSyncState(failed).status, "storage-error");
  assert.equal(store.actions.deleteItem(item.id), false);
  db.pendingOperations.hook("creating").unsubscribe(fail);
  await store.persistence.retry();
  assert.equal(store.getSnapshot().storageError, null);
  assert.equal(store.getSnapshot().unsavedOperationCount, 0);
  assert.deepEqual((await repository.getWorkspace("product-workspace")).pendingOperations, operations);
  assert.equal(await db.pendingOperations.count(), 3);
});

test("an interrupted transaction leaves the previous commit intact", async (t) => {
  const { db, repository, store } = await setup(t);
  await store.persistence.initialize();
  const before = await repository.getWorkspace("product-workspace");
  const abort = () => { Dexie.currentTransaction.abort(); };
  db.pendingOperations.hook("creating", abort);
  store.actions.deleteItem("RLY-014");
  await assert.rejects(store.persistence.flush());
  assert.deepEqual(await repository.getWorkspace("product-workspace"), before);
  assert.ok(store.getSnapshot().storageError);
  db.pendingOperations.hook("creating").unsubscribe(abort);
  await store.persistence.retry();
  assert.equal((await repository.getWorkspace("product-workspace")).items["RLY-014"], undefined);
});

test("retry after a commit with a lost response is idempotent", async (t) => {
  const { db, repository } = await setup(t);
  let loseResponse = true;
  const store = createWorkspaceStore({ repository: { ...repository,
    async commitMutation(...args) {
      await repository.commitMutation(...args);
      if (loseResponse) { loseResponse = false; throw new Error("Lost response"); }
    },
  } });
  await store.persistence.initialize();
  store.actions.renameStage("planned", "Once only");
  await assert.rejects(store.persistence.flush());
  await store.persistence.retry();
  assert.equal(await db.pendingOperations.count(), 1);
  assert.equal(store.getSnapshot().persistedLocalRevision, 1);
});

test("stale tabs cannot overwrite another tab's edits or pending queue", async (t) => {
  const { repository, store } = await setup(t);
  const other = createWorkspaceStore({ repository });
  await Promise.all([store.persistence.initialize(), other.persistence.initialize()]);
  store.actions.renameStage("idea", "From tab one");
  await store.persistence.flush();
  other.actions.renameStage("planned", "From tab two");
  await assert.rejects(other.persistence.flush(), { name: "StaleWorkspaceError" });
  const saved = await repository.getWorkspace("product-workspace");
  assert.equal(saved.stages.idea.name, "From tab one");
  assert.equal(saved.stages.planned.name, "PLANNED");
  assert.equal(saved.pendingOperations.length, 1);
  assert.equal(other.getSnapshot().unsavedOperationCount, 1);
});

test("confirmed server metadata stays separate from offline local revisions", async (t) => {
  const { repository, store } = await setup(t);
  await store.persistence.initialize();
  await repository.saveSyncMetadata({ workspaceId: "product-workspace", localRevision: 0,
    lastServerVersion: 42, confirmedServerVersion: 42, lastSyncedAt: "2026-09-22T01:00:00.000Z" });
  const restored = createWorkspaceStore({ repository });
  await restored.persistence.initialize();
  restored.actions.renameStage("planned", "Offline edit");
  await restored.persistence.flush();
  const metadata = await repository.getSyncMetadata("product-workspace");
  assert.equal(metadata.localRevision, 1);
  assert.equal(metadata.lastServerVersion, 42);
  assert.equal(getSyncSnapshot(restored.getSnapshot()).serverVersion, 42);
});

for (const name of ["MissingAPIError", "SecurityError", "BlockedError"]) {
  test(`${name} blocks startup visibly and never falls back to editable mock data`, async () => {
    const error = new Error("Unavailable"); error.name = name;
    const repository = createWorkspaceRepository(async () => { throw error; });
    const store = createWorkspaceStore({ repository });
    await assert.rejects(store.persistence.initialize(), { name });
    assert.equal(store.getSnapshot().restoration, "error");
    assert.ok(store.getSnapshot().storageError);
    assert.equal(store.actions.createItem("Must not queue", "idea"), undefined);
    assert.equal(store.getSnapshot().pendingOperations.length, 0);
  });
}

for (const corruption of ["entity", "operation", "ordering", "orphan"]) {
  test(`invalid ${corruption} data is preserved and never reseeded`, async (t) => {
    const { db, repository, store } = await setup(t);
    await store.persistence.initialize();
    store.actions.renameStage("planned", "Keep this queue");
    await store.persistence.flush();
    if (corruption === "entity") await db.workItems.update(["product-workspace", "RLY-014"], { title: 15 });
    if (corruption === "operation") await db.pendingOperations.update(store.getSnapshot().lastOperation.id, { type: "UNKNOWN" });
    if (corruption === "ordering") await db.workspaces.update("product-workspace", { stageOrder: [] });
    if (corruption === "orphan") await db.workspaces.delete("product-workspace");
    const before = await Promise.all(db.tables.map((table) => table.toArray()));
    const restored = createWorkspaceStore({ repository });
    await assert.rejects(restored.persistence.initialize(), { name: "InvalidLocalDataError" });
    assert.equal(restored.getSnapshot().restoration, "error");
    assert.deepEqual(await Promise.all(db.tables.map((table) => table.toArray())), before);
  });
}

test("schema v1 migrates metadata while preserving modified entities, deletions, and queue order", async (t) => {
  const name = `relay-migration-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(1).stores({ workspaces: "id", workflowStages: "[workspaceId+id], workspaceId",
    workItems: "[workspaceId+id], workspaceId, [workspaceId+stageId]",
    pendingOperations: "id, workspaceId, &[workspaceId+sequence]", workspaceSyncMetadata: "workspaceId" });
  await old.open();
  const memory = createWorkspaceStore({ repository: null });
  memory.actions.deleteItem("RLY-014");
  memory.actions.renameStage("idea", "Migrated backlog");
  const state = memory.getSnapshot();
  await createWorkspaceRepository(async () => old).saveWorkspace(state);
  await old.table("workspaceSyncMetadata").put({ workspaceId: state.workspace.id, lastServerVersion: 9, lastSyncedAt: null });
  const queue = await old.table("pendingOperations").toArray();
  old.close();
  const db = new RelayDatabase(name);
  t.after(() => db.delete());
  await db.open();
  const restored = createWorkspaceStore({ repository: createWorkspaceRepository(async () => db) });
  await restored.persistence.initialize();
  assert.deepEqual(selectBoard(restored.getSnapshot()), selectBoard(state));
  assert.deepEqual(await db.pendingOperations.toArray(), queue);
  assert.equal(restored.getSnapshot().syncMetadata.localRevision, 2);
  assert.equal(restored.getSnapshot().syncMetadata.lastServerVersion, 9);
});


test("a future schema fails explicitly without clearing existing data", async (t) => {
  const name = `relay-future-${crypto.randomUUID()}`;
  const db = new RelayDatabase(name);
  await db.open();
  await db.workspaceSyncMetadata.put({ workspaceId: "retained", localRevision: 0, lastServerVersion: null, lastSyncedAt: null });
  db.close();
  const future = new Dexie(name);
  future.version(6).stores({ workspaces: "id", workflowStages: "[workspaceId+id], workspaceId",
    workItems: "[workspaceId+id], workspaceId, [workspaceId+stageId]",
    pendingOperations: "id, workspaceId, &[workspaceId+sequence]", workspaceSyncMetadata: "workspaceId" });
  await future.open();
  future.close();
  t.after(() => future.delete());
  await assert.rejects(db.open(), { name: "VersionError" });
  await future.open();
  assert.equal(await future.table("workspaceSyncMetadata").count(), 1);
  future.close();
});
