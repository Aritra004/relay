import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceStore } from "./workspace-store.ts";
import { getSyncStatusLabel, selectSyncState } from "./sync-state.ts";
import { getSyncSnapshot } from "./sync-inspector-data.ts";

for (const online of [true, false]) {
  test(`four edits update the pending count and label immediately ${online ? "online" : "offline"}`, () => {
    const store = createWorkspaceStore({ repository: null, items: [] });
    store.setOnline(online);
    const original = store.getSnapshot();
    assert.deepEqual(original.pendingOperations, []);
    assert.equal(getSyncSnapshot(original).pendingCount, 0);
    assert.deepEqual(getSyncSnapshot(original).activity, []);
    assert.equal(getSyncSnapshot(original).localVersion, 0);
    assert.equal(getSyncSnapshot(original).serverVersion, null);
    assert.equal(
      getSyncStatusLabel(selectSyncState(original)),
      online ? "Saved locally" : "Offline",
    );
    const counts = [];
    const labels = [];
    store.subscribe(() => {
      const state = store.getSnapshot();
      counts.push(state.pendingOperations.length);
      labels.push(getSyncStatusLabel(selectSyncState(state)));
      assert.equal(state.pendingOperations.at(-1), state.lastOperation);
      assert.equal(
        getSyncSnapshot(state).pendingCount,
        state.pendingOperations.length,
      );
    });

    const created = store.actions.createItem("New item", "planned");
    assert.equal(
      getSyncStatusLabel(selectSyncState(store.getSnapshot())),
      `${online ? "" : "Offline · "}1 change pending`,
    );
    store.actions.updateItem(created.id, { title: "Updated item" });
    store.actions.moveItem({
      itemId: created.id,
      stageId: "building",
      beforeItemId: null,
    });
    store.actions.deleteItem(created.id);
    const state = store.getSnapshot();
    assert.deepEqual(counts, [1, 2, 3, 4]);
    assert.deepEqual(labels, [
      `${online ? "" : "Offline · "}1 change pending`,
      `${online ? "" : "Offline · "}2 changes pending`,
      `${online ? "" : "Offline · "}3 changes pending`,
      `${online ? "" : "Offline · "}4 changes pending`,
    ]);
    assert.deepEqual(
      state.pendingOperations.map(({ type }) => type),
      ["CREATE_ITEM", "UPDATE_ITEM", "MOVE_ITEM", "DELETE_ITEM"],
    );
    assert.ok(
      state.pendingOperations.every(({ entityId }) => entityId === created.id),
    );
    assert.equal(new Set(state.pendingOperations.map(({ id }) => id)).size, 4);
    assert.equal(
      getSyncStatusLabel(selectSyncState(state)),
      `${online ? "" : "Offline · "}4 changes pending`,
    );
    assert.equal(getSyncSnapshot(state).pendingCount, 4);
    assert.deepEqual(original.pendingOperations, []);
    assert.equal(
      createWorkspaceStore({ repository: null }).getSnapshot().pendingOperations.length,
      0,
    );
  });
}

test("queued operations remain immutable and survive item deletion, reconnect, and consumer remounts", () => {
  const store = createWorkspaceStore({ repository: null, items: [] });
  const created = store.actions.createItem("Original", "idea");
  const firstSnapshot = store.getSnapshot();
  const firstOperation = firstSnapshot.pendingOperations[0];
  const unsubscribe = store.subscribe(() => {});
  unsubscribe();
  store.actions.updateItem(created.id, { title: "Edited" });
  store.actions.renameStage("idea", "Backlog");
  store.actions.deleteItem(created.id);
  const queue = store.getSnapshot().pendingOperations;
  assert.deepEqual(
    queue.map(({ type }) => type),
    ["CREATE_ITEM", "UPDATE_ITEM", "RENAME_STAGE", "DELETE_ITEM"],
  );
  assert.equal(store.getSnapshot().items[created.id], undefined);
  assert.equal(queue[0], firstOperation);
  assert.equal(firstOperation.payload.title, "Original");
  assert.equal(firstSnapshot.pendingOperations.length, 1);
  assert.throws(() => queue.pop(), TypeError);
  assert.throws(() => queue.push(firstOperation), TypeError);
  assert.throws(() => {
    queue[0].payload.title = "Bypass";
  }, TypeError);
  store.setOnline(false);
  store.setOnline(true);
  let observed;
  store.subscribe(() => {
    observed = store.getSnapshot().pendingOperations;
  });
  store.setOnline(false);
  assert.equal(observed, queue);
  assert.deepEqual(
    JSON.parse(JSON.stringify(store.getSnapshot())).pendingOperations,
    queue,
  );
});

test("the inspector describes the full queue, including repeated edits, cleared fields, and deleted items", () => {
  const store = createWorkspaceStore({ repository: null, items: [] });
  const created = store.actions.createItem("Original", "planned");
  store.actions.updateItem(created.id, { title: "Edit 1" });
  store.actions.updateItem(created.id, { title: "" });
  store.actions.updateItem(created.id, { description: "Context" });
  store.actions.updateItem(created.id, { description: "" });
  store.actions.updateItem(created.id, { title: "Edit 5", description: "Final context" });
  store.actions.deleteItem(created.id);
  const state = store.getSnapshot();
  const queueBefore = structuredClone(state.pendingOperations);
  const inspector = getSyncSnapshot(state);
  assert.equal(inspector.pendingCount, 7);
  assert.equal(inspector.activity.length, 7);
  assert.deepEqual(
    inspector.activity.map(({ id }) => id),
    state.pendingOperations
      .slice()
      .reverse()
      .map(({ id }) => id),
  );
  assert.equal(new Set(inspector.activity.map(({ id }) => id)).size, 7);
  assert.deepEqual(
    inspector.activity.map(({ label }) => label),
    [
      "Deleted item",
      "Updated item title and description",
      "Updated item description",
      "Updated item description",
      "Updated item title",
      "Updated item title",
      "Created item",
    ],
  );
  assert.equal(inspector.activity[1].detail, "Edit 5");
  assert.equal(inspector.activity[4].detail, "Untitled item");
  assert.equal(inspector.activity.at(-1).detail, "Original");
  assert.ok(inspector.activity.every(({ state }) => state === "pending"));
  assert.equal(inspector.localVersion, 7);
  assert.equal(inspector.serverVersion, null);
  assert.equal(inspector.lastSync, null);
  assert.deepEqual(state.pendingOperations, queueBefore);
  store.setOnline(false);
  store.setOnline(true);
  assert.deepEqual(getSyncSnapshot(store.getSnapshot()), inspector);
});
