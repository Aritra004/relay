import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayDatabase } from "./local-db.ts";
import { createWorkspaceRepository } from "./workspace-repository.ts";
import {
  createWorkspaceStore,
  selectBoard,
} from "../components/workspace/workspace-store.ts";

function environment(t, value) {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  t.after(() => {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  });
}

test("production starts without seeded cards or mock collaborators", async (t) => {
  environment(t, "production");
  const data = await import(`../components/workspace/workspace-data.ts?production=${crypto.randomUUID()}`);
  assert.deepEqual(data.initialItems, []);
  assert.deepEqual(data.initialWorkspace.members, ["You"]);
  assert.equal(createWorkspaceStore({ repository: null }).development, undefined);
});

async function setup(t) {
  environment(t, "development");
  const db = new RelayDatabase(`relay-development-${crypto.randomUUID()}`);
  await db.open();
  t.after(() => db.delete());
  const repository = createWorkspaceRepository(async () => db);
  const store = createWorkspaceStore({ repository });
  await store.persistence.initialize();
  return { db, repository, store };
}

for (const online of [true, false]) {
  test(`development reset clears all local tables and durably reseeds ${online ? "online" : "offline"}`, async (t) => {
    const { db, repository, store } = await setup(t);
    const seed = store.getSnapshot();
    const other = createWorkspaceStore({
      repository: null,
      workspace: { id: "other", name: "Other workspace", members: ["You"] },
    });
    other.actions.renameStage("planned", "Another pending operation");
    await repository.saveWorkspace(other.getSnapshot());
    await repository.saveSyncMetadata({
      workspaceId: "other",
      localRevision: 1,
      lastServerVersion: 8,
      lastSyncedAt: null,
    });
    store.actions.createItem("Remove on reset", "planned");
    store.actions.deleteItem("RLY-014");
    store.actions.renameStage("idea", "Changed");
    await store.persistence.flush();
    await store.development.resetWorkspace(online);
    const clean = store.getSnapshot();
    assert.deepEqual(selectBoard(clean), selectBoard(seed));
    assert.deepEqual(clean.pendingOperations, []);
    assert.equal(clean.persistedLocalRevision, 0);
    assert.equal(clean.syncMetadata.lastServerVersion, null);
    assert.equal(clean.syncMetadata.lastSyncedAt, null);
    assert.equal(clean.syncStatus, online ? "local" : "offline");
    assert.equal(clean.storageError, null);
    assert.equal(clean.isResetting, false);
    assert.equal(await db.workspaces.count(), 1);
    assert.equal(await db.workflowStages.count(), 5);
    assert.equal(await db.workItems.count(), Object.keys(seed.items).length);
    assert.equal(await db.pendingOperations.count(), 0);
    assert.equal(await db.workspaceSyncMetadata.count(), 1);
    const restored = createWorkspaceStore({ repository });
    await restored.persistence.initialize();
    assert.deepEqual(selectBoard(restored.getSnapshot()), selectBoard(seed));
    assert.deepEqual(restored.getSnapshot().pendingOperations, []);
    restored.actions.createItem("Next offline test", "idea");
    await restored.persistence.flush();
    assert.equal(await db.pendingOperations.count(), 1);
    await restored.development.resetWorkspace(online);
    assert.equal(await db.pendingOperations.count(), 0);
    assert.notEqual(
      restored.getSnapshot().syncMetadata.localGeneration,
      clean.syncMetadata.localGeneration,
    );
  });
}

test("reset settles the active write, cancels queued writes, and blocks new edits until reseeding completes", async (t) => {
  const { db, repository } = await setup(t);
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  let commitCount = 0;
  const store = createWorkspaceStore({
    repository: {
      ...repository,
      async commitMutation(...args) {
        commitCount++;
        await gate;
        return repository.commitMutation(...args);
      },
    },
  });
  await store.persistence.initialize();
  store.actions.createItem("Active write", "planned");
  store.actions.renameStage("idea", "Queued write");
  const reset = store.development.resetWorkspace(false);
  assert.equal(store.development.resetWorkspace(false), reset);
  assert.equal(store.getSnapshot().isResetting, true);
  assert.equal(store.actions.createItem("During reset", "idea"), undefined);
  release();
  await reset;
  assert.equal(commitCount, 1);
  assert.equal(await db.pendingOperations.count(), 0);
  assert.deepEqual(store.getSnapshot().pendingOperations, []);
  assert.equal(store.getSnapshot().stages.idea.name, "IDEA");
  assert.equal(store.getSnapshot().syncStatus, "offline");
});

test("failed reseeding rolls back the clear and keeps unsaved operations available for retry", async (t) => {
  const { db, repository, store } = await setup(t);
  store.actions.renameStage("idea", "Committed");
  await store.persistence.flush();
  const fail = () => {
    throw new DOMException("Test full disk", "QuotaExceededError");
  };
  db.pendingOperations.hook("creating", fail);
  store.actions.createItem("Unsaved work", "planned");
  await assert.rejects(store.persistence.flush());
  const queue = store.getSnapshot().pendingOperations;
  const before = await repository.getWorkspace("product-workspace");
  db.workflowStages.hook("creating", fail);
  await assert.rejects(store.development.resetWorkspace(true));
  assert.deepEqual(await repository.getWorkspace("product-workspace"), before);
  assert.deepEqual(store.getSnapshot().pendingOperations, queue);
  assert.equal(store.getSnapshot().unsavedOperationCount, 1);
  assert.equal(store.getSnapshot().isResetting, false);
  assert.match(store.getSnapshot().storageError, /Reset failed/);
  db.workflowStages.hook("creating").unsubscribe(fail);
  db.pendingOperations.hook("creating").unsubscribe(fail);
  await store.persistence.retry();
  assert.deepEqual(
    (await repository.getWorkspace("product-workspace")).pendingOperations,
    queue,
  );
});

test("a stale tab at the same revision cannot write into a reset workspace", async (t) => {
  const { db, repository, store } = await setup(t);
  const stale = createWorkspaceStore({ repository });
  await stale.persistence.initialize();
  await store.development.resetWorkspace(true);
  assert.equal(
    stale.getSnapshot().persistedLocalRevision,
    store.getSnapshot().persistedLocalRevision,
  );
  stale.actions.renameStage("planned", "Old tab");
  await assert.rejects(stale.persistence.flush(), {
    name: "StaleWorkspaceError",
  });
  assert.equal(await db.pendingOperations.count(), 0);
  assert.equal(
    (await repository.getWorkspace("product-workspace")).stages.planned.name,
    "PLANNED",
  );
});

test("an explicit developer reset recovers invalid records without using normal restoration", async (t) => {
  const { db, repository } = await setup(t);
  await db.workspaces.update("product-workspace", { stageOrder: ["invalid"] });
  const store = createWorkspaceStore({ repository });
  await assert.rejects(store.persistence.initialize());
  await store.development.resetWorkspace(true);
  assert.equal(store.getSnapshot().restoration, "ready");
  assert.equal(store.getSnapshot().stageOrder.length, 5);
  assert.equal(store.getSnapshot().storageError, null);
});

for (const mode of ["production", "test", undefined]) {
  test(`persistent reset capabilities are absent in ${mode ?? "unset"} mode`, (t) => {
    environment(t, mode);
    const repository = createWorkspaceRepository();
    assert.equal(repository.development, undefined);
    assert.equal(createWorkspaceStore({ repository }).development, undefined);
  });
}

test("retained development capabilities reject calls after leaving development mode", async (t) => {
  const { repository, store } = await setup(t);
  process.env.NODE_ENV = "production";
  await assert.rejects(
    store.development.resetWorkspace(true),
    /only in development/,
  );
  await assert.rejects(
    repository.development.resetLocalDatabase(store.getSnapshot()),
    /only in development/,
  );
});
