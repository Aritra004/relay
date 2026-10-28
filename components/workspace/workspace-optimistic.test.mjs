import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceStore,
  selectBoard,
  selectSelectedItem,
} from "./workspace-store.ts";
import { selectSyncState } from "./sync-state.ts";
import { getSyncSnapshot } from "./sync-inspector-data.ts";

const seed = () => [
  {
    id: "task",
    version: 1,
    title: "Build the editor",
    description: "Original context",
    stageId: "planned",
    assignee: "You",
    label: "Engineering",
    updated: "Yesterday",
  },
];

const scenarios = [
  {
    name: "createItem",
    type: "CREATE_ITEM",
    label: "Created item",
    run: (actions) => actions.createItem("New item", "planned"),
    verify: (board, selected) => {
      const planned = board.find(({ stage }) => stage.id === "planned");
      assert.deepEqual(
        planned.items.map(({ title }) => title),
        ["Build the editor", "New item"],
      );
      assert.equal(planned.totalItems, 2);
      assert.equal(planned.items[1].changed, true);
      assert.equal(selected.id, "task");
    },
  },
  {
    name: "updateItem",
    type: "UPDATE_ITEM",
    label: "Updated item title and description",
    run: (actions) =>
      actions.updateItem("task", {
        title: "Updated title",
        description: "Updated context",
      }),
    verify: (board, selected) => {
      const card = board.find(({ stage }) => stage.id === "planned").items[0];
      assert.equal(card, selected);
      assert.equal(card.title, "Updated title");
      assert.equal(card.description, "Updated context");
      assert.equal(card.changed, true);
    },
  },
  {
    name: "deleteItem",
    type: "DELETE_ITEM",
    label: "Deleted item",
    run: (actions) => actions.deleteItem("task"),
    verify: (board, selected) => {
      const planned = board.find(({ stage }) => stage.id === "planned");
      assert.deepEqual(planned.items, []);
      assert.equal(planned.totalItems, 0);
      assert.equal(selected, undefined);
    },
  },
  {
    name: "moveItem",
    type: "MOVE_ITEM",
    label: "Moved item to BUILDING",
    run: (actions) =>
      actions.moveItem({
        itemId: "task",
        stageId: "building",
        beforeItemId: null,
      }),
    verify: (board, selected) => {
      const planned = board.find(({ stage }) => stage.id === "planned");
      const building = board.find(({ stage }) => stage.id === "building");
      assert.deepEqual(planned.items, []);
      assert.equal(planned.totalItems, 0);
      assert.equal(building.totalItems, 1);
      assert.equal(building.items[0], selected);
      assert.equal(selected.stageId, "building");
      assert.equal(selected.changed, true);
    },
  },
  {
    name: "renameStage",
    type: "RENAME_STAGE",
    label: "Renamed stage",
    run: (actions) => actions.renameStage("planned", "Ready to build"),
    verify: (board, selected) => {
      const planned = board.find(({ stage }) => stage.id === "planned");
      assert.equal(planned.stage.name, "Ready to build");
      assert.equal(planned.items[0], selected);
      assert.equal(planned.totalItems, 1);
    },
  },
];

for (const online of [true, false]) {
  for (const scenario of scenarios) {
    test(`${scenario.name} publishes immediately ${online ? "online" : "offline"}, with unconfirmed edits`, () => {
      const store = createWorkspaceStore({ repository: null, items: seed() });
      store.setOnline(online);
      store.selectItem("task");
      // Pending work must never turn the next action into a wait for sync.
      store.actions.createItem("Earlier unconfirmed edit", "idea");
      const before = store.getSnapshot();
      let actionReturned = false;
      const notifications = [];
      const unsubscribe = store.subscribe(() => {
        assert.equal(
          actionReturned,
          false,
          "subscribers must run before the action returns",
        );
        const state = store.getSnapshot();
        assert.equal(state.lastOperation.type, scenario.type);
        assert.notEqual(state.lastOperation.id, before.lastOperation.id);
        assert.ok(Object.isFrozen(state.lastOperation));
        assert.equal(state.pendingOperations.at(-1), state.lastOperation);
        assert.ok(Object.isFrozen(state.pendingOperations));
        for (const item of Object.values(state.items))
          assert.equal(item.version, 1);
        notifications.push(state);
        // The same selectors used by the board and editor already see the edit.
        scenario.verify(selectBoard(state), selectSelectedItem(state));
        assert.equal(state.pendingOperations.length, 2);
        // The inspector sees the same complete edit in this notification.
        const inspector = getSyncSnapshot(state);
        assert.equal(inspector.pendingCount, 2);
        assert.equal(inspector.activity.length, 2);
        assert.equal(inspector.activity[0].id, state.lastOperation.id);
        assert.equal(inspector.activity[0].label, scenario.label);
        assert.equal(inspector.localVersion, 2);
        assert.equal(inspector.serverVersion, null);
        assert.deepEqual(
          selectSyncState(state),
          online
            ? { status: "pending", pendingCount: 2 }
            : { status: "offline", pendingCount: 2 },
        );
      });

      // Deliberately do not await, advance timers, or flush a task queue.
      const result = scenario.run(store.actions);
      actionReturned = true;
      assert.ok(result);
      assert.equal(
        typeof result.then,
        "undefined",
        "actions must return a local result, not a Promise",
      );
      assert.equal(
        notifications.length,
        1,
        "the complete edit must publish exactly once, immediately",
      );
      const after = store.getSnapshot();
      assert.equal(notifications[0], after);
      assert.notEqual(after, before);
      scenario.verify(selectBoard(after), selectSelectedItem(after));
      if (scenario.name === "createItem")
        assert.equal(after.items[result.id], result);
      unsubscribe();

      // Changing connectivity never rolls back an optimistic edit or confirms it.
      store.setOnline(!online);
      store.setOnline(true);
      const reconnected = store.getSnapshot();
      assert.equal(reconnected.items, after.items);
      assert.equal(reconnected.stages, after.stages);
      assert.equal(reconnected.itemOrderByStage, after.itemOrderByStage);
      assert.equal(reconnected.selectedItemId, after.selectedItemId);
      assert.equal(reconnected.pendingOperations, after.pendingOperations);
      assert.deepEqual(selectSyncState(reconnected), {
        status: "pending",
        pendingCount: 2,
      });
    });
  }
}
