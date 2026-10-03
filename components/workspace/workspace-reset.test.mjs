import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceStore } from "./workspace-store.ts";
import { selectSyncState } from "./sync-state.ts";
import { getSyncSnapshot } from "./sync-inspector-data.ts";

function withNodeEnv(value, run) {
  const previous = process.env.NODE_ENV;
  if (value === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = value;
  try {
    run();
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
}

for (const online of [true, false]) {
  test(`development reset restores the seed atomically ${online ? "online" : "offline"} and supports further edits`, () => {
    withNodeEnv("development", () => {
      const store = createWorkspaceStore({ repository: null });
      const initial = store.getSnapshot();
      const actions = store.actions;
      const created = actions.createItem("Temporary item", "idea");
      actions.updateItem("RLY-014", { title: "Edited title", description: "New context" });
      actions.moveItem({ itemId: "RLY-014", stageId: "review", beforeItemId: null });
      actions.moveItem({ itemId: "RLY-019", stageId: "idea", beforeItemId: "RLY-018" });
      actions.renameStage("planned", "Ready");
      actions.deleteItem("RLY-006");
      store.selectItem(created.id);
      // The reset must use current browser connectivity, even if the store is stale.
      store.setOnline(!online);
      const dirty = store.getSnapshot();
      assert.equal(dirty.pendingOperations.length, 6);
      const expected = { ...initial, syncStatus: online ? "local" : "offline" };

      let returned = false;
      let notifications = 0;
      const unsubscribe = store.subscribe(() => {
        assert.equal(returned, false);
        notifications++;
        assert.deepEqual(store.getSnapshot(), expected);
      });
      store.development.resetWorkspace(online);
      returned = true;
      unsubscribe();

      assert.equal(notifications, 1);
      assert.equal(store.getServerSnapshot(), initial);
      assert.equal(store.actions, actions);
      assert.equal(store.getSnapshot().selectedItemId, null);
      assert.equal(store.getSnapshot().lastOperation, null);
      assert.deepEqual(selectSyncState(store.getSnapshot()), online
        ? { status: "local" }
        : { status: "offline", pendingCount: 0 });
      const inspector = getSyncSnapshot(store.getSnapshot());
      assert.equal(inspector.pendingCount, 0);
      assert.deepEqual(inspector.activity, []);
      assert.equal(inspector.localVersion, 0);
      assert.equal(inspector.serverVersion, null);
      assert.equal(inspector.lastSync, null);
      assert.ok(Object.isFrozen(store.getSnapshot()));
      assert.equal(dirty.pendingOperations.length, 6);
      assert.equal(dirty.items[created.id].title, "Temporary item");
      assert.deepEqual(createWorkspaceStore({ repository: null }).getSnapshot(), initial);

      // A reset remains safe to repeat and retained action references still work.
      store.development.resetWorkspace(online);
      assert.deepEqual(store.getSnapshot(), expected);
      const next = actions.createItem("After reset", "planned");
      assert.notEqual(next.id, created.id);
      assert.equal(store.getSnapshot().pendingOperations.length, 1);
      assert.equal(store.getSnapshot().lastOperation.entityId, next.id);
      store.development.resetWorkspace(online);
      assert.deepEqual(store.getSnapshot(), expected);
    });
  });
}

for (const environment of ["production", "test", undefined]) {
  test(`reset capability is unavailable when NODE_ENV is ${environment ?? "unset"}`, () => {
    withNodeEnv(environment, () => {
      const store = createWorkspaceStore({ repository: null });
      store.actions.createItem("Keep this edit", "planned");
      assert.equal(store.development, undefined);
      assert.equal(store.getSnapshot().pendingOperations.length, 1);
    });
  });
}
