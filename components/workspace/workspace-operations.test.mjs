import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceStore } from "./workspace-store.ts";
import { applyWorkspaceOperation } from "./apply-workspace-operation.ts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const item = (id, stageId = "planned", assignee = "You") => ({
  id, stageId, assignee, version: 7, title: id, description: "Context",
  label: "Product", updated: "Yesterday",
});

test("each board action creates a standalone operation that reproduces its entire state change", () => {
  const store = createWorkspaceStore({ repository: null,
    workspace: { id: "another-workspace", name: "Another workspace", members: ["You"] },
    items: [],
  });
  store.setOnline(false);
  assert.equal(store.getSnapshot().lastOperation, null);
  const operations = [];

  function perform(type, action) {
    const before = store.getSnapshot();
    const beforeCopy = structuredClone(before);
    const observed = [];
    const unsubscribe = store.subscribe(() => observed.push(store.getSnapshot()));
    const result = action();
    unsubscribe();
    assert.ok(result);
    const after = store.getSnapshot();
    const operation = after.lastOperation;
    assert.equal(observed.length, 1);
    assert.equal(observed[0], after);
    assert.equal(operation.type, type);
    assert.match(operation.id, uuid);
    assert.equal(operation.workspaceId, "another-workspace");
    assert.equal(new Date(operation.timestamp).toISOString(), operation.timestamp);
    assert.equal(after.pendingOperations.length, before.pendingOperations.length + 1);
    assert.deepEqual(after.pendingOperations, [...before.pendingOperations, operation]);
    assert.ok(Object.isFrozen(operation));
    if (operation.payload !== null) assert.ok(Object.isFrozen(operation.payload));

    const serializedOperation = JSON.parse(JSON.stringify(operation));
    const replayed = applyWorkspaceOperation(before, serializedOperation);
    assert.deepEqual({ ...replayed, syncMetadata: after.syncMetadata, persistedLocalRevision: after.persistedLocalRevision }, after);
    assert.equal(after.syncMetadata.localRevision, before.syncMetadata.localRevision + 1);
    assert.deepEqual(before, beforeCopy);
    assert.deepEqual(serializedOperation, operation);
    operations.push(operation);
    return result;
  }

  const created = perform("CREATE_ITEM", () => store.actions.createItem("  Local work  ", "planned"));
  assert.equal(operations[0].entityId, created.id);
  assert.notEqual(operations[0].id, created.id);
  assert.equal(operations[0].baseVersion, null);
  assert.deepEqual(operations[0].payload, {
    title: "Local work", description: "", stageId: "planned",
    assignee: "You", label: "Product", version: 1,
  });
  store.selectItem(created.id);

  perform("UPDATE_ITEM", () => store.actions.updateItem(created.id, { title: "Renamed work" }));
  assert.deepEqual(operations[1].payload, { title: "Renamed work" });
  perform("MOVE_ITEM", () => store.actions.moveItem({
    itemId: created.id, stageId: "building", beforeItemId: null,
  }));
  assert.deepEqual(operations[2].payload, { stageId: "building", beforeItemId: null });
  perform("RENAME_STAGE", () => store.actions.renameStage("building", "  In progress  "));
  assert.equal(operations[3].entityId, "building");
  assert.equal(operations[3].baseVersion, null);
  assert.deepEqual(operations[3].payload, { name: "In progress" });
  perform("DELETE_ITEM", () => store.actions.deleteItem(created.id));
  assert.equal(operations[4].payload, null);
  assert.equal(store.getSnapshot().selectedItemId, null);
  assert.deepEqual(store.getSnapshot().itemOrderByStage.building, []);
  for (const operation of [operations[1], operations[2], operations[4]]) {
    assert.equal(operation.entityId, created.id);
    assert.equal(operation.baseVersion, 1);
  }
  assert.equal(new Set(operations.map(({ id }) => id)).size, 5);
  assert.deepEqual(store.getSnapshot().pendingOperations, operations);
  assert.equal(store.getSnapshot().syncStatus, "offline");
});

test("update operations contain only changed editable fields and capture the existing version", () => {
  const store = createWorkspaceStore({ repository: null, items: [item("a")] });
  const changes = { title: "Edited", description: "Context", version: 99, stageId: "review" };
  store.actions.updateItem("a", changes);
  const operation = store.getSnapshot().lastOperation;
  changes.title = "Changed caller input";
  assert.deepEqual(operation.payload, { title: "Edited" });
  assert.equal(operation.baseVersion, 7);
  assert.equal(store.getSnapshot().items.a.version, 7);
  assert.throws(() => { operation.payload.title = "Bypass"; }, TypeError);
  assert.throws(() => { operation.entityId = "Bypass"; }, TypeError);

  store.actions.updateItem("a", { description: "" });
  assert.deepEqual(store.getSnapshot().lastOperation.payload, { description: "" });
  store.actions.updateItem("a", { title: "Both", description: "New context" });
  assert.deepEqual(store.getSnapshot().lastOperation.payload, { title: "Both", description: "New context" });
  store.actions.moveItem({ itemId: "a", stageId: "review", beforeItemId: null });
  assert.equal(store.getSnapshot().lastOperation.baseVersion, 7);
  assert.equal(store.getSnapshot().items.a.version, 7);
  store.actions.deleteItem("a");
  assert.equal(store.getSnapshot().lastOperation.baseVersion, 7);
});

test("keyboard operations record resolved neighbors and preserve hidden items", () => {
  const store = createWorkspaceStore({ repository: null, items: [
    item("a"), item("hidden", "planned", "Mina"), item("b"), item("c"),
  ] });
  const before = store.getSnapshot();
  store.actions.moveItem({ itemId: "a", direction: "down", filters: { onlyMine: true } });
  const moved = store.getSnapshot();
  assert.deepEqual(moved.lastOperation.payload, { stageId: "planned", beforeItemId: "c" });
  assert.deepEqual(moved.itemOrderByStage.planned, ["hidden", "b", "a", "c"]);
  assert.deepEqual({ ...applyWorkspaceOperation(before, moved.lastOperation), syncMetadata: moved.syncMetadata, persistedLocalRevision: moved.persistedLocalRevision }, moved);
  store.actions.moveItem({ itemId: "a", direction: "right" });
  assert.deepEqual(store.getSnapshot().lastOperation.payload, { stageId: "building", beforeItemId: null });
});

test("no-op actions, selections, and connectivity never replace the last applied operation", () => {
  const store = createWorkspaceStore({ repository: null, items: [item("a")] });
  store.actions.updateItem("a", { title: "Edited" });
  const before = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => notifications++);
  store.actions.updateItem("a", { title: "Edited" });
  store.actions.updateItem("missing", { title: "Ignored" });
  store.actions.moveItem({ itemId: "a", stageId: "planned", beforeItemId: null });
  store.actions.moveItem({ itemId: "a", stageId: "building", beforeItemId: "missing" });
  store.actions.renameStage("planned", " PLANNED ");
  store.actions.renameStage("planned", " ");
  store.actions.createItem(" ", "planned");
  store.actions.deleteItem("missing");
  assert.equal(store.getSnapshot(), before);
  assert.equal(notifications, 0);

  store.selectItem("a");
  store.setOnline(false);
  store.setOnline(true);
  assert.equal(store.getSnapshot().lastOperation, before.lastOperation);
  assert.equal(store.getSnapshot().pendingOperations, before.pendingOperations);
  assert.equal(store.getSnapshot().pendingOperations.length, 1);
});

test("operation application rejects other workspaces, missing targets, and stale move anchors", () => {
  const store = createWorkspaceStore({ repository: null, items: [item("a"), item("b", "building")] });
  store.actions.updateItem("a", { title: "Edited" });
  const state = store.getSnapshot();
  const metadata = {
    id: "operation", workspaceId: state.workspace.id, entityId: "a",
    baseVersion: 7, timestamp: "2026-09-18T00:00:00.000Z",
  };
  for (const operation of [
    { ...metadata, workspaceId: "other-workspace", type: "DELETE_ITEM", payload: null },
    { ...metadata, entityId: "missing", type: "UPDATE_ITEM", payload: { title: "Ignored" } },
    { ...metadata, entityId: "missing", type: "DELETE_ITEM", payload: null },
    { ...metadata, type: "CREATE_ITEM", baseVersion: null, payload: {
      title: "Duplicate", description: "", stageId: "planned", assignee: "You", label: "Product", version: 1,
    } },
    { ...metadata, type: "MOVE_ITEM", payload: { stageId: "planned", beforeItemId: "b" } },
    { ...metadata, type: "MOVE_ITEM", payload: { stageId: "missing", beforeItemId: null } },
    { ...metadata, type: "MOVE_ITEM", payload: { stageId: "planned", beforeItemId: null } },
    { ...metadata, entityId: "missing", type: "RENAME_STAGE", baseVersion: null, payload: { name: "Ignored" } },
  ]) assert.equal(applyWorkspaceOperation(state, operation), state);
});
