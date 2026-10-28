import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createWorkspaceStore,
  selectBoard,
  selectItems,
  selectSelectedItem,
  selectStages,
} from "./workspace-store.ts";
import { selectSyncState } from "./sync-state.ts";
import { getSyncSnapshot } from "./sync-inspector-data.ts";

test("the public mutation API contains exactly the five supported actions", () => {
  const store = createWorkspaceStore({ repository: null });
  assert.deepEqual(Object.keys(store.actions).sort(), [
    "createItem",
    "deleteItem",
    "moveItem",
    "renameStage",
    "updateItem",
  ]);
  assert.throws(() => {
    store.actions.patchState = () => {};
  }, TypeError);
  assert.throws(() => {
    store.actions = {};
  }, TypeError);
});

const seed = () =>
  [
    ["a", "idea"],
    ["hidden", "idea"],
    ["b", "idea"],
    ["c", "planned"],
    ["d", "planned"],
  ].map(([id, stageId]) => ({
    id,
    version: 1,
    stageId,
    title: id,
    description: `Description ${id}`,
    assignee: "You",
    label: "Product",
    updated: "Yesterday",
  }));

function assertConsistent(state) {
  const orderedIds = state.stageOrder.flatMap((stageId) => {
    const ids = state.itemOrderByStage[stageId];
    for (const id of ids) assert.equal(state.items[id].stageId, stageId);
    return ids;
  });
  assert.equal(new Set(orderedIds).size, orderedIds.length);
  assert.deepEqual([...orderedIds].sort(), Object.keys(state.items).sort());
  assert.equal(
    new Set(state.stageOrder).size,
    Object.keys(state.stages).length,
  );
  if (state.selectedItemId !== null) assert.ok(selectSelectedItem(state));
}

test("snapshots, selector results, and created items cannot bypass the actions", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  function assertProtected() {
    const state = store.getSnapshot();
    const copy = structuredClone(state);
    const mutations = [
      () => {
        state.pendingOperations.length = 999;
      },
      () => {
        state.workspace.name = "Bypass";
      },
      () => state.workspace.members.push("Alex"),
      () => {
        state.items.a.title = "Bypass";
      },
      () => {
        delete state.items.a;
      },
      () => {
        state.stages.idea.name = "Bypass";
      },
      () => {
        delete state.stages.idea;
      },
      () => state.stageOrder.reverse(),
      () => {
        state.itemOrderByStage.idea = [];
      },
      () => state.itemOrderByStage.idea.push("invalid"),
      () => {
        selectItems(state)[0].description = "Bypass";
      },
      () => {
        selectBoard(state)[0].stage.name = "Bypass";
      },
    ];
    for (const mutate of mutations) assert.throws(mutate, TypeError);
    assert.equal(store.getSnapshot(), state);
    assert.deepEqual(state, copy);
  }

  assertProtected();
  const created = store.actions.createItem("New", "idea");
  assert.throws(() => {
    created.title = "Bypass";
  }, TypeError);
  assertProtected();
  store.actions.updateItem("a", { title: "Edited" });
  assertProtected();
  store.actions.moveItem({
    itemId: "a",
    stageId: "planned",
    beforeItemId: null,
  });
  assertProtected();
  store.actions.renameStage("idea", "Backlog");
  assertProtected();
  store.actions.deleteItem(created.id);
  assertProtected();
  store.selectItem("a");
  assert.throws(() => {
    selectSelectedItem(store.getSnapshot()).title = "Bypass";
  }, TypeError);
  store.setOnline(false);
  assertProtected();
  assert.equal(store.getSnapshot().pendingOperations.length, 5);
  assert.equal(store.getServerSnapshot().items.a.title, "a");
});

test("delete atomically removes the selected item and stale callbacks cannot restore it", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  store.actions.moveItem({
    itemId: "a",
    stageId: "review",
    beforeItemId: null,
  });
  store.selectItem("a");
  const before = store.getSnapshot();
  const copy = structuredClone(before);
  const staleUpdate = store.actions.updateItem;
  const staleMove = store.actions.moveItem;
  let notifications = 0;
  store.subscribe(() => {
    notifications++;
    assertConsistent(store.getSnapshot());
    assert.equal(selectSelectedItem(store.getSnapshot()), undefined);
  });

  assert.equal(store.actions.deleteItem("a"), true);
  const after = store.getSnapshot();
  assert.equal(after.items.a, undefined);
  assert.deepEqual(after.itemOrderByStage.review, []);
  assert.equal(after.selectedItemId, null);
  assert.equal(
    after.pendingOperations.length,
    before.pendingOperations.length + 1,
  );
  assert.equal(after.items.b, before.items.b);
  assert.equal(after.itemOrderByStage.idea, before.itemOrderByStage.idea);
  assert.equal(after.stages, before.stages);
  assert.equal(after.stageOrder, before.stageOrder);
  assert.deepEqual(before, copy);
  assert.equal(store.actions.deleteItem("a"), false);
  assert.equal(staleUpdate("a", { title: "Stale edit" }), false);
  assert.equal(
    staleMove({ itemId: "a", stageId: "idea", beforeItemId: null }),
    false,
  );
  assert.equal(staleMove({ itemId: "a", direction: "right" }), false);
  store.selectItem("a");
  assert.equal(store.getSnapshot(), after);
  assert.equal(notifications, 1);
});

test("deleting other items preserves selection and deleted IDs are never reused", () => {
  const store = createWorkspaceStore({ repository: null, items: [] });
  const first = store.actions.createItem("First", "idea");
  const second = store.actions.createItem("Second", "idea");
  store.selectItem(second.id);
  store.setOnline(false);
  store.actions.deleteItem(first.id);
  assert.equal(selectSelectedItem(store.getSnapshot()), second);
  assert.deepEqual(store.getSnapshot().itemOrderByStage.idea, [second.id]);
  store.actions.deleteItem(second.id);
  assert.equal(selectItems(store.getSnapshot()).length, 0);
  assert.equal(store.getSnapshot().selectedItemId, null);
  const third = store.actions.createItem("Third", "idea");
  assert.notEqual(third.id, first.id);
  assert.notEqual(third.id, second.id);
  assert.equal(store.getSnapshot().pendingOperations.length, 5);
  assert.equal(store.getSnapshot().syncStatus, "offline");
  assertConsistent(store.getSnapshot());
});

test("update only accepts editable fields even from untyped callers", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  const before = store.getSnapshot();
  store.actions.updateItem("a", {
    title: "Edited",
    description: "Context",
    id: "replacement",
    stageId: "review",
    assignee: "Mina",
    label: "Design",
    updated: "Fake",
    changed: false,
    version: 99,
  });
  const after = store.getSnapshot();
  assert.deepEqual(after.items.a, {
    ...before.items.a,
    title: "Edited",
    description: "Context",
    updated: "Just now",
    changed: true,
  });
  assert.equal(after.items.replacement, undefined);
  assert.equal(after.itemOrderByStage, before.itemOrderByStage);
  assert.equal(after.pendingOperations.length, 1);
  assertConsistent(after);
});

test("all subscribers observe atomic moves, selection, and pending counts", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  store.selectItem("a");
  const before = store.getSnapshot();
  const beforeCopy = structuredClone(before);
  const columns = [];
  const editor = [];
  store.subscribe(() => {
    assertConsistent(store.getSnapshot());
    columns.push(store.getSnapshot());
  });
  store.subscribe(() => editor.push(store.getSnapshot()));

  store.actions.moveItem({
    itemId: "a",
    stageId: "planned",
    beforeItemId: "d",
  });
  assert.equal(columns.length, 1);
  assert.equal(editor[0], columns[0]);
  assert.deepEqual(columns[0].itemOrderByStage.idea, ["hidden", "b"]);
  assert.deepEqual(columns[0].itemOrderByStage.planned, ["c", "a", "d"]);
  assert.equal(selectSelectedItem(columns[0]).stageId, "planned");
  assert.equal(columns[0].pendingOperations.length, 1);
  assert.deepEqual(before, beforeCopy);
  assert.equal(columns[0].items.b, before.items.b);
  assert.equal(columns[0].stages, before.stages);
  assert.equal(columns[0].stageOrder, before.stageOrder);
  for (const stageId of ["building", "review", "shipped"]) {
    assert.equal(
      columns[0].itemOrderByStage[stageId],
      before.itemOrderByStage[stageId],
    );
  }
});

test("unsubscribing and remounting consumers never reseeds workspace state", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  let notifications = 0;
  const unsubscribe = store.subscribe(() => notifications++);
  store.actions.updateItem("a", { title: "Shared title" });
  unsubscribe();
  store.actions.renameStage("idea", "Possibilities");
  store.selectItem("a");
  store.setOnline(false);
  const created = store.actions.createItem("While unmounted", "review");
  const remounted = store.getSnapshot();
  assert.equal(remounted.items.a.title, "Shared title");
  assert.equal(remounted.stages.idea.name, "Possibilities");
  assert.equal(remounted.stageOrder[0], "idea");
  assert.equal(remounted.items[created.id].title, "While unmounted");
  assert.equal(remounted.selectedItemId, "a");
  assert.equal(remounted.syncStatus, "offline");
  assert.equal(remounted.pendingOperations.length, 3);
  assert.equal(notifications, 1);
  let observed;
  store.subscribe(() => {
    observed = store.getSnapshot();
  });
  store.actions.updateItem("a", { description: "Still shared" });
  assert.equal(observed, store.getSnapshot());
  assert.equal(observed.pendingOperations.length, 4);
  assertConsistent(observed);
});

test("actions called from an older render merge against the latest state", () => {
  const items = seed();
  items[0].version = 7;
  const store = createWorkspaceStore({ repository: null, items });
  const update = store.actions.updateItem;
  store.actions.moveItem({
    itemId: "a",
    stageId: "building",
    beforeItemId: null,
  });
  update("a", { title: "New title" });
  update("a", { description: "New description" });
  assert.equal(store.getSnapshot().items.a.stageId, "building");
  assert.equal(store.getSnapshot().items.a.title, "New title");
  assert.equal(store.getSnapshot().items.a.description, "New description");
  assert.equal(store.getSnapshot().items.a.version, 7);
  assert.deepEqual(store.getSnapshot().itemOrderByStage.building, ["a"]);
  assertConsistent(store.getSnapshot());
});

test("updating fields commits exactly once without changing membership or ordering", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  store.selectItem("a");
  const before = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => {
    notifications++;
    assertConsistent(store.getSnapshot());
  });
  store.actions.updateItem("a", {
    title: "Edited",
    description: "Context",
  });
  const state = store.getSnapshot();
  assert.equal(state.itemOrderByStage, before.itemOrderByStage);
  assert.equal(selectSelectedItem(state).stageId, "idea");
  assert.equal(selectSelectedItem(state).title, "Edited");
  assert.equal(selectSelectedItem(state).description, "Context");
  assert.equal(state.pendingOperations.length, 1);
  assert.equal(notifications, 1);
  assert.equal(state.stages, before.stages);
  assert.equal(state.stageOrder, before.stageOrder);
  assert.equal(state.items.c, before.items.c);
  assert.equal(state.itemOrderByStage.review, before.itemOrderByStage.review);
});

test("filtered neighbor moves preserve hidden items and handle empty lanes", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  store.actions.moveItem({ itemId: "a", stageId: "idea", beforeItemId: "b" });
  assert.deepEqual(store.getSnapshot().itemOrderByStage.idea, [
    "hidden",
    "a",
    "b",
  ]);
  store.actions.moveItem({
    itemId: "b",
    stageId: "idea",
    beforeItemId: "hidden",
  });
  assert.deepEqual(store.getSnapshot().itemOrderByStage.idea, [
    "b",
    "hidden",
    "a",
  ]);
  store.actions.moveItem({ itemId: "b", stageId: "idea", beforeItemId: null });
  assert.deepEqual(store.getSnapshot().itemOrderByStage.idea, [
    "hidden",
    "a",
    "b",
  ]);
  store.actions.moveItem({
    itemId: "a",
    stageId: "shipped",
    beforeItemId: null,
  });
  assert.deepEqual(store.getSnapshot().itemOrderByStage.shipped, ["a"]);
  assertConsistent(store.getSnapshot());
});

test("no-op and invalid actions neither notify subscribers nor count operations", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  const original = store.getSnapshot();
  let notifications = 0;
  store.subscribe(() => notifications++);
  for (const move of [
    { itemId: "a", stageId: "idea", beforeItemId: "a" },
    { itemId: "a", stageId: "idea", beforeItemId: "hidden" },
    { itemId: "b", stageId: "idea", beforeItemId: null },
    { itemId: "missing", stageId: "idea", beforeItemId: null },
    { itemId: "a", stageId: "idea", beforeItemId: "missing" },
    { itemId: "a", stageId: "planned", beforeItemId: "b" },
    { itemId: "a", stageId: "missing", beforeItemId: null },
  ])
    store.actions.moveItem(move);
  store.actions.updateItem("a", { title: "a", stageId: "idea" });
  store.actions.updateItem("missing", { title: "Ignored" });
  store.actions.updateItem("a", { stageId: "missing" });
  store.actions.renameStage("idea", " IDEA ");
  store.actions.renameStage("idea", "  ");
  store.actions.renameStage("missing", "Ignored");
  store.actions.deleteItem("missing");
  store.actions.createItem(" ", "idea");
  store.actions.createItem("Ignored", "missing");
  store.selectItem("missing");
  store.selectItem(null);
  store.setOnline(true);
  assert.equal(store.getSnapshot(), original);
  assert.equal(notifications, 0);

  const move = { itemId: "a", stageId: "planned", beforeItemId: "d" };
  store.actions.moveItem(move);
  const moved = store.getSnapshot();
  store.actions.moveItem(move);
  assert.equal(store.getSnapshot(), moved);
  assert.equal(notifications, 1);
});

test("sync indicator and inspector agree through edits and offline/reconnect", () => {
  const store = createWorkspaceStore({ repository: null, items: [] });
  assert.deepEqual(selectSyncState(store.getSnapshot()), { status: "local" });
  store.setOnline(false);
  assert.deepEqual(selectSyncState(store.getSnapshot()), {
    status: "offline",
    pendingCount: 0,
  });
  store.setOnline(true);
  assert.deepEqual(selectSyncState(store.getSnapshot()), { status: "local" });
  store.actions.createItem("First", "idea");
  store.setOnline(false);
  store.actions.createItem("Second", "building");
  const offline = selectSyncState(store.getSnapshot());
  assert.deepEqual(offline, { status: "offline", pendingCount: 2 });
  assert.equal(getSyncSnapshot(store.getSnapshot()).pendingCount, 2);
  store.setOnline(true);
  const online = selectSyncState(store.getSnapshot());
  assert.deepEqual(online, { status: "pending", pendingCount: 2 });
  assert.equal(getSyncSnapshot(store.getSnapshot()).pendingCount, 2);
  assert.equal(store.getSnapshot().pendingOperations.length, 2);
});

test("creation generates distinct client UUIDs across independent stores", () => {
  const items = seed();
  items.push({ ...items[0], id: "RLY-027" });
  const store = createWorkspaceStore({ repository: null, items });
  const otherClient = createWorkspaceStore({ repository: null, items });
  const first = store.actions.createItem("  First  ", "idea");
  const second = store.actions.createItem("Second", "planned");
  const third = otherClient.actions.createItem(
    "First on another client",
    "idea",
  );
  const fourth = otherClient.actions.createItem(
    "Second on another client",
    "planned",
  );
  const ids = [first.id, second.id, third.id, fourth.id];
  for (const id of ids) {
    assert.match(
      id,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
  }
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(store.getSnapshot().items["RLY-027"].id, "RLY-027");
  assert.equal(first.title, "First");
  assert.equal(store.getSnapshot().items[first.id], first);
  assert.equal(store.getSnapshot().pendingOperations.length, 2);
  assertConsistent(store.getSnapshot());
  assertConsistent(otherClient.getSnapshot());
});

test("a new offline item can be edited and moved immediately using its permanent ID", () => {
  const store = createWorkspaceStore({ repository: null, items: [] });
  store.setOnline(false);
  const created = store.actions.createItem("Local item", "planned");
  const id = created.id;
  store.selectItem(id);

  // No server response or asynchronous work between creation and these actions.
  assert.equal(
    store.actions.updateItem(id, {
      title: "Edited locally",
      description: "Ready to build",
    }),
    true,
  );
  assert.equal(
    store.actions.moveItem({
      itemId: id,
      stageId: "building",
      beforeItemId: null,
    }),
    true,
  );
  assert.equal(
    store.actions.moveItem({ itemId: id, direction: "right" }),
    true,
  );

  const state = store.getSnapshot();
  assert.deepEqual(Object.keys(state.items), [id]);
  assert.equal(state.items[id].id, id);
  assert.equal(state.items[id].title, "Edited locally");
  assert.equal(state.items[id].description, "Ready to build");
  assert.equal(selectSelectedItem(state).id, id);
  assert.deepEqual(state.itemOrderByStage.planned, []);
  assert.deepEqual(state.itemOrderByStage.building, []);
  assert.deepEqual(state.itemOrderByStage.review, [id]);
  assert.equal(state.pendingOperations.length, 4);
  assert.equal(state.syncStatus, "offline");
  assertConsistent(state);
});

test("serialized items retain their IDs when loaded into a new store", () => {
  const original = createWorkspaceStore({ repository: null, items: [] });
  const created = original.actions.createItem("Keep this identity", "planned");
  original.actions.updateItem(created.id, { description: "Saved context" });
  original.actions.moveItem({
    itemId: created.id,
    stageId: "building",
    beforeItemId: null,
  });

  // Exercise the data round trip that later persistence/sync will use.
  // The app does not yet persist or restore snapshots on a real page refresh.
  const snapshot = JSON.parse(JSON.stringify(original.getSnapshot()));
  const restored = createWorkspaceStore({ repository: null,
    workspace: snapshot.workspace,
    items: selectItems(snapshot),
  });
  assert.deepEqual(
    restored.getSnapshot().items[created.id],
    snapshot.items[created.id],
  );
  assert.deepEqual(restored.getSnapshot().itemOrderByStage.building, [
    created.id,
  ]);
  assert.equal(
    restored.actions.updateItem(created.id, { title: "Edited after restore" }),
    true,
  );
  assert.equal(
    restored.actions.moveItem({
      itemId: created.id,
      stageId: "shipped",
      beforeItemId: null,
    }),
    true,
  );
  restored.setOnline(true);
  const another = restored.actions.createItem("Another item", "idea");
  assert.notEqual(another.id, created.id);
  assert.equal(restored.getSnapshot().items[created.id].id, created.id);
  assert.equal(
    restored.getSnapshot().items[created.id].description,
    "Saved context",
  );
  assert.deepEqual(restored.getSnapshot().itemOrderByStage.shipped, [
    created.id,
  ]);
  assertConsistent(restored.getSnapshot());
});

test("renaming a stage preserves stage order, workspace metadata, and items", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  const before = store.getSnapshot();
  assert.equal(store.actions.renameStage("review", "  Feedback  "), true);
  assert.equal(store.getSnapshot().workspace, before.workspace);
  assert.equal(store.getSnapshot().stageOrder, before.stageOrder);
  assert.equal(store.getSnapshot().items, before.items);
  assert.equal(store.getSnapshot().pendingOperations.length, 1);
  assert.deepEqual(
    selectStages(store.getSnapshot()).map((stage) => stage.name),
    ["IDEA", "PLANNED", "BUILDING", "Feedback", "SHIPPED"],
  );
  assert.deepEqual(
    selectItems(store.getSnapshot()).map((item) => item.id),
    ["a", "hidden", "b", "c", "d"],
  );
  assertConsistent(store.getSnapshot());
});

test("store instances and server snapshots are isolated from later client edits", () => {
  const items = seed();
  const first = createWorkspaceStore({ repository: null, items });
  const second = createWorkspaceStore({ repository: null, items });
  const server = first.getServerSnapshot();
  items[0].title = "Changed seed";
  assert.equal(first.getSnapshot().items.a.title, "a");
  first.actions.updateItem("a", { title: "First request" });
  first.actions.renameStage("idea", "First stage");
  assert.equal(second.getSnapshot().items.a.title, "a");
  assert.equal(second.getSnapshot().stages.idea.name, "IDEA");
  assert.equal(second.getSnapshot().pendingOperations.length, 0);
  assert.equal(first.getServerSnapshot(), server);
  assert.equal(server.items.a.title, "a");
});

test("the complete board reconstructs from a serialized snapshot without component state", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  const created = store.actions.createItem("Captured idea", "idea");
  store.actions.updateItem("a", {
    title: "Ready for feedback",
    description: "Edited context",
  });
  store.actions.moveItem({
    itemId: "a",
    stageId: "review",
    beforeItemId: null,
  });
  store.actions.moveItem({
    itemId: "b",
    stageId: "idea",
    beforeItemId: "hidden",
  });
  store.actions.renameStage("idea", "BACKLOG");
  store.selectItem("a");
  const serialized = JSON.stringify(store.getSnapshot());
  const reconstructed = selectBoard(JSON.parse(serialized));

  assert.deepEqual(
    reconstructed.map(({ stage, items, totalItems }) => ({
      stage: stage.name,
      ids: items.map((item) => item.id),
      totalItems,
    })),
    [
      { stage: "BACKLOG", ids: ["b", "hidden", created.id], totalItems: 3 },
      { stage: "PLANNED", ids: ["c", "d"], totalItems: 2 },
      { stage: "BUILDING", ids: [], totalItems: 0 },
      { stage: "REVIEW", ids: ["a"], totalItems: 1 },
      { stage: "SHIPPED", ids: [], totalItems: 0 },
    ],
  );
  assert.equal(reconstructed[3].items[0].title, "Ready for feedback");
  assert.equal(reconstructed[3].items[0].description, "Edited context");
  assert.equal(reconstructed[3].items[0].changed, true);
  assert.deepEqual(reconstructed, selectBoard(store.getSnapshot()));
  assert.deepEqual(
    selectSelectedItem(JSON.parse(serialized)),
    reconstructed[3].items[0],
  );

  // A fresh consumer of this snapshot needs no live store, seeds, or UI history.
  store.actions.updateItem("a", { title: "Later edit" });
  store.actions.renameStage("idea", "Later name");
  assert.deepEqual(selectBoard(JSON.parse(serialized)), reconstructed);
});

test("board filtering is a view of stored ordering and never changes domain data", () => {
  const items = seed();
  items[0].title = "Visible first";
  items[2].title = "Visible last";
  items[1].assignee = "Mina";
  items[1].label = "Design";
  const store = createWorkspaceStore({ repository: null, items });
  store.actions.moveItem({ itemId: "b", stageId: "idea", beforeItemId: "a" });
  const snapshot = store.getSnapshot();
  const copy = structuredClone(snapshot);
  const filtered = selectBoard(snapshot, {
    query: " VISIBLE ",
    onlyMine: true,
    category: "Product",
  });
  assert.deepEqual(
    filtered[0].items.map((item) => item.id),
    ["b", "a"],
  );
  assert.equal(filtered[0].totalItems, 3);
  assert.equal(filtered[1].items.length, 0);
  assert.equal(filtered[1].totalItems, 2);
  assert.deepEqual(
    selectBoard(snapshot, { category: "Design" })[0].items.map(
      (item) => item.id,
    ),
    ["hidden"],
  );
  assert.deepEqual(
    selectBoard(snapshot)[0].items.map((item) => item.id),
    ["b", "a", "hidden"],
  );
  assert.equal(store.getSnapshot(), snapshot);
  assert.deepEqual(snapshot, copy);
  assert.ok(
    selectBoard(createWorkspaceStore({ repository: null, items: [] }).getSnapshot()).every(
      (lane) => lane.items.length === 0 && lane.totalItems === 0,
    ),
  );
});

test("directional moves use current stage and item order after other store actions", () => {
  const store = createWorkspaceStore({ repository: null, items: seed() });
  const move = store.actions.moveItem;
  store.selectItem("a");
  assert.equal(move({ itemId: "a", direction: "right" }), true);
  assert.equal(selectSelectedItem(store.getSnapshot()).stageId, "planned");

  // The same callback follows a later stage change instead of its original lane.
  store.actions.moveItem({ itemId: "a", stageId: "idea", beforeItemId: null });
  assert.equal(move({ itemId: "a", direction: "up" }), true);
  assert.deepEqual(store.getSnapshot().itemOrderByStage.idea, [
    "hidden",
    "a",
    "b",
  ]);
  assert.equal(move({ itemId: "a", direction: "right" }), true);
  assert.deepEqual(store.getSnapshot().itemOrderByStage.planned, [
    "c",
    "d",
    "a",
  ]);
  assertConsistent(store.getSnapshot());
  assert.equal(store.getSnapshot().pendingOperations.length, 4);
});

test("directional moves preserve filtered cards and boundary actions are no-ops", () => {
  const items = seed();
  items[1].assignee = "Mina";
  const store = createWorkspaceStore({ repository: null, items });
  let notifications = 0;
  store.subscribe(() => {
    notifications++;
    assertConsistent(store.getSnapshot());
  });
  assert.equal(
    store.actions.moveItem({
      itemId: "a",
      direction: "down",
      filters: { onlyMine: true },
    }),
    true,
  );
  assert.deepEqual(store.getSnapshot().itemOrderByStage.idea, [
    "hidden",
    "b",
    "a",
  ]);
  assert.equal(
    store.actions.moveItem({
      itemId: "a",
      direction: "up",
      filters: { onlyMine: true },
    }),
    true,
  );
  assert.deepEqual(store.getSnapshot().itemOrderByStage.idea, [
    "hidden",
    "a",
    "b",
  ]);
  const snapshot = store.getSnapshot();
  for (const [id, direction] of [
    ["a", "up"],
    ["b", "down"],
    ["a", "left"],
    ["hidden", "up"],
    ["missing", "right"],
  ])
    assert.equal(
      store.actions.moveItem({
        itemId: id,
        direction,
        filters: { onlyMine: true },
      }),
      false,
    );
  assert.equal(store.getSnapshot(), snapshot);
  assert.equal(notifications, 2);
});
