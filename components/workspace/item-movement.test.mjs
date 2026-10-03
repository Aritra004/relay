import { test } from "node:test";
import assert from "node:assert/strict";
import { moveWorkItem } from "./item-movement.ts";
import { createWorkspaceStore } from "./workspace-store.ts";

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child && typeof child === "object") freeze(child);
  }
  return Object.freeze(value);
}

function board() {
  const items = [
    ["a", "idea"],
    ["b", "idea"],
    ["c", "idea"],
    ["d", "planned"],
    ["e", "planned"],
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
  return freeze(createWorkspaceStore({ repository: null, items }).getSnapshot());
}
const order = (state, stage) => state.itemOrderByStage[stage];

test("reorders to the start, middle, and end without mutating source data", () => {
  const original = board();
  const snapshot = structuredClone(original);
  const start = moveWorkItem(original, {
    itemId: "c",
    stageId: "idea",
    beforeItemId: "a",
  });
  assert.deepEqual(order(start, "idea"), ["c", "a", "b"]);
  const middle = moveWorkItem(start, {
    itemId: "c",
    stageId: "idea",
    beforeItemId: "b",
  });
  assert.deepEqual(order(middle, "idea"), ["a", "c", "b"]);
  const end = moveWorkItem(middle, {
    itemId: "a",
    stageId: "idea",
    beforeItemId: null,
  });
  assert.deepEqual(order(end, "idea"), ["c", "b", "a"]);
  assert.deepEqual(original, snapshot);
  assert.equal(end.items.d, original.items.d);
});

test("moves across stages and into an empty stage, preserving card fields", () => {
  const original = board();
  const moved = moveWorkItem(original, {
    itemId: "a",
    stageId: "planned",
    beforeItemId: "e",
  });
  assert.deepEqual(order(moved, "idea"), ["b", "c"]);
  assert.deepEqual(order(moved, "planned"), ["d", "a", "e"]);
  assert.deepEqual(
    moved.items.a,
    {
      ...original.items.a,
      stageId: "planned",
      updated: "Just now",
      changed: true,
    },
  );
  const empty = moveWorkItem(moved, {
    itemId: "a",
    stageId: "building",
    beforeItemId: null,
  });
  assert.deepEqual(order(empty, "building"), ["a"]);
  assert.equal(Object.keys(empty.items).length, Object.keys(original.items).length);
  const ids = Object.values(empty.itemOrderByStage).flat();
  assert.equal(ids.length, Object.keys(original.items).length);
  assert.equal(new Set(ids).size, ids.length);
  const movedAgain = moveWorkItem(empty, {
    itemId: "a", stageId: "review", beforeItemId: null,
  });
  assert.deepEqual(order(movedAgain, "building"), []);
  assert.deepEqual(order(movedAgain, "review"), ["a"]);
});

test("visible neighbor anchors preserve hidden cards when a filtered board is reordered", () => {
  const original = board(); // b is hidden by a filter; a is dropped before visible c.
  const moved = moveWorkItem(original, {
    itemId: "a",
    stageId: "idea",
    beforeItemId: "c",
  });
  assert.deepEqual(order(moved, "idea"), ["b", "a", "c"]);
  assert.equal(moved.items.b, original.items.b);
});

test("no-op, repeated, and stale moves leave state untouched", () => {
  const original = board();
  for (const move of [
    { itemId: "a", stageId: "idea", beforeItemId: "a" },
    { itemId: "a", stageId: "idea", beforeItemId: "b" },
    { itemId: "c", stageId: "idea", beforeItemId: null },
    { itemId: "missing", stageId: "idea", beforeItemId: null },
    { itemId: "a", stageId: "idea", beforeItemId: "missing" },
    { itemId: "a", stageId: "planned", beforeItemId: "b" },
    { itemId: "a", stageId: "missing", beforeItemId: null },
  ])
    assert.equal(moveWorkItem(original, move), original);
  const move = { itemId: "a", stageId: "planned", beforeItemId: "e" };
  const once = moveWorkItem(original, move);
  assert.equal(moveWorkItem(once, move), once);
});

test("cross-stage movement changes only the moved entity and its two order lists", () => {
  const original = board();
  const moved = moveWorkItem(original, {
    itemId: "a", stageId: "planned", beforeItemId: "e",
  });
  assert.deepEqual(Object.keys(original).filter((key) => moved[key] !== original[key]),
    ["items", "itemOrderByStage"]);
  assert.deepEqual(Object.keys(original.items).filter((id) => moved.items[id] !== original.items[id]),
    ["a"]);
  assert.deepEqual(Object.keys(original.itemOrderByStage).filter((stageId) =>
    moved.itemOrderByStage[stageId] !== original.itemOrderByStage[stageId]),
    ["idea", "planned"]);
  assert.deepEqual(moved.items.a, {
    ...original.items.a, stageId: "planned", changed: true, updated: "Just now",
  });
  assert.equal(moved.stages, original.stages);
  assert.equal(moved.stageOrder, original.stageOrder);
});

test("within-stage movement replaces only that order list and preserves card content", () => {
  const original = board();
  const moved = moveWorkItem(original, {
    itemId: "c", stageId: "idea", beforeItemId: "a",
  });
  assert.deepEqual(Object.keys(original.itemOrderByStage).filter((stageId) =>
    moved.itemOrderByStage[stageId] !== original.itemOrderByStage[stageId]),
    ["idea"]);
  assert.deepEqual(Object.keys(original.items).filter((id) => moved.items[id] !== original.items[id]),
    ["c"]);
  assert.deepEqual(moved.items.c, {
    ...original.items.c, changed: true, updated: "Just now",
  });
  assert.equal(moved.stages, original.stages);
  assert.equal(moved.stageOrder, original.stageOrder);
  assert.deepEqual(order(moved, "idea"), ["c", "a", "b"]);
});
