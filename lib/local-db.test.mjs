import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayDatabase, openLocalDatabase } from "./local-db.ts";
import {
  createWorkspaceStore,
  selectBoard,
} from "../components/workspace/workspace-store.ts";

async function openTestDatabase(t) {
  const db = new RelayDatabase(`relay-test-${crypto.randomUUID()}`);
  t.after(() => db.delete());
  await db.open();
  return db;
}

test("browser initialization rejects server use without creating a database", async () => {
  assert.equal(typeof window, "undefined");
  await assert.rejects(openLocalDatabase(), /only available in the browser/);
});

test("client initialization opens an empty database and reuses it without clearing records", async (t) => {
  // Supply the browser guard while fake-indexeddb provides the storage API.
  Object.defineProperty(globalThis, "window", { value: {}, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
  const [db, sameDb] = await Promise.all([openLocalDatabase(), openLocalDatabase()]);
  t.after(() => db.delete());
  assert.equal(db, sameDb);
  assert.equal(db.isOpen(), true);
  assert.equal(db.backendDB().objectStoreNames.length, 7);
  const metadata = { workspaceId: "retained", localRevision: 0, lastServerVersion: null, lastSyncedAt: null };
  await db.workspaceSyncMetadata.add(metadata);
  assert.equal(await openLocalDatabase(), db);
  assert.deepEqual(await db.workspaceSyncMetadata.get("retained"), metadata);
});

test("the local tables retain domain records and operation order after reopening", async (t) => {
  const db = await openTestDatabase(t);
  assert.deepEqual([...db.backendDB().objectStoreNames], [
    "confirmedWorkspaces",
    "pendingOperations",
    "recoveryBackups",
    "workItems",
    "workflowStages",
    "workspaceSyncMetadata",
    "workspaces",
  ]);
  for (const table of db.tables) assert.equal(await table.count(), 0);

  const store = createWorkspaceStore({ repository: null });
  const item = store.actions.createItem("Persistent identity", "planned");
  store.actions.updateItem(item.id, { description: "Stored as domain data" });
  store.actions.moveItem({ itemId: item.id, stageId: "idea", beforeItemId: "RLY-018" });
  store.actions.renameStage("planned", "Ready");
  store.actions.deleteItem("RLY-019");
  const state = store.getSnapshot();
  const workspaceId = state.workspace.id;
  const workspace = {
    ...state.workspace,
    stageOrder: state.stageOrder,
    itemOrderByStage: state.itemOrderByStage,
  };
  const pending = state.pendingOperations.map((operation, sequence) => ({
    ...operation,
    sequence,
  }));
  const metadata = { workspaceId, localRevision: 0, lastServerVersion: null, lastSyncedAt: null };

  await db.transaction("rw", db.tables, async () => {
    await db.workspaces.add(workspace);
    await db.workflowStages.bulkAdd(
      Object.values(state.stages).map((stage) => ({ ...stage, workspaceId })),
    );
    await db.workItems.bulkAdd(
      Object.values(state.items).map((record) => ({ ...record, workspaceId })),
    );
    // Insertion order and random operation IDs must not determine queue order.
    await db.pendingOperations.bulkAdd([...pending].reverse());
    await db.workspaceSyncMetadata.add(metadata);
  });

  db.close();
  await db.open();
  assert.deepEqual(await db.workspaces.get(workspaceId), workspace);
  assert.deepEqual(await db.workspaceSyncMetadata.get(workspaceId), metadata);
  const stages = await db.workflowStages.where({ workspaceId }).toArray();
  const items = await db.workItems.where({ workspaceId }).toArray();
  const restoreMap = (records) => Object.fromEntries(records.map((record) => {
    const entity = { ...record };
    delete entity.workspaceId;
    return [entity.id, entity];
  }));
  const restored = {
    ...workspace,
    stages: restoreMap(stages),
    items: restoreMap(items),
  };
  assert.deepEqual(selectBoard(restored), selectBoard(state));
  assert.deepEqual(
    await db.pendingOperations
      .where("[workspaceId+sequence]")
      .between([workspaceId, 0], [workspaceId, pending.length])
      .toArray(),
    pending,
  );
});

test("workspace-scoped keys and stage queries isolate reused domain IDs", async (t) => {
  const db = await openTestDatabase(t);
  const state = createWorkspaceStore({ repository: null }).getSnapshot();
  for (const workspaceId of ["workspace-a", "workspace-b"]) {
    await db.workflowStages.add({ ...state.stages.planned, workspaceId });
    await db.workItems.add({ ...state.items["RLY-014"], workspaceId });
  }
  await db.workflowStages.update(["workspace-a", "planned"], { name: "Ready" });
  await db.workItems.update(["workspace-a", "RLY-014"], { stageId: "idea" });
  assert.equal((await db.workflowStages.get(["workspace-b", "planned"])).name, "PLANNED");
  assert.deepEqual(
    await db.workItems.where("[workspaceId+stageId]").equals(["workspace-a", "planned"]).toArray(),
    [],
  );
  assert.deepEqual(
    await db.workItems.where("[workspaceId+stageId]").equals(["workspace-b", "planned"]).toArray(),
    [{ ...state.items["RLY-014"], workspaceId: "workspace-b" }],
  );
});

test("a duplicate queue sequence aborts the accompanying entity write", async (t) => {
  const db = await openTestDatabase(t);
  const store = createWorkspaceStore({ repository: null });
  store.actions.updateItem("RLY-014", { title: "First change" });
  const first = store.getSnapshot();
  await db.pendingOperations.add({ ...first.lastOperation, sequence: 0 });
  await db.workItems.add({ ...first.items["RLY-014"], workspaceId: first.workspace.id });

  store.actions.updateItem("RLY-014", { title: "Second change" });
  const second = store.getSnapshot();
  await assert.rejects(
    db.transaction("rw", db.workItems, db.pendingOperations, async () => {
      await db.workItems.put({ ...second.items["RLY-014"], workspaceId: second.workspace.id });
      await db.pendingOperations.add({ ...second.lastOperation, sequence: 0 });
    }),
    { name: "ConstraintError" },
  );
  assert.equal((await db.workItems.get([first.workspace.id, "RLY-014"])).title, "First change");
  assert.equal(await db.pendingOperations.count(), 1);
});
