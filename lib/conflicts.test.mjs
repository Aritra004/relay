import assert from "node:assert/strict";
import { test } from "node:test";
import { syncFixture, until } from "./sync-test-helpers.mjs";
import { createWorkspaceStore } from "../components/workspace/workspace-store.ts";
import {
  conflictingFields,
  unresolvedConflicts,
  nextUpload,
} from "./conflict-contract.ts";

const conflicts = (f) =>
  unresolvedConflicts(f.store.getSnapshot().syncMetadata);
async function setup(t) {
  const f = await syncFixture(t),
    item = f.create("Original");
  await f.store.sync.apply(f.accept(item), 1);
  return { ...f, itemId: item.entityId };
}
const resolve = (f, choice) => {
  const c = conflicts(f)[0];
  return f.store.sync.resolve(c.id, choice, c.serverWorkspaceVersion);
};

test("all operation pairs have explicit overlap rules, independent of version", async (t) => {
  const f = await setup(t);
  const ops = [
    f.create(),
    f.operation("UPDATE_ITEM", f.itemId, { title: "Title" }),
    f.operation("MOVE_ITEM", f.itemId, {
      stageId: f.otherStage,
      beforeItemId: null,
    }),
    f.operation("DELETE_ITEM", f.itemId, null),
    f.operation("RENAME_STAGE", f.itemId, { name: "Name" }, 0),
  ];
  const expected = [
    [true, true, true, true, false],
    [true, true, false, true, false],
    [true, false, true, true, false],
    [true, true, true, false, false],
    [false, false, false, false, true],
  ];
  for (let i = 0; i < ops.length; i++)
    for (let j = 0; j < ops.length; j++) {
      const a = { ...ops[i], entityId: f.itemId },
        b = { ...ops[j], entityId: f.itemId };
      assert.equal(
        conflictingFields(a, b).length > 0,
        expected[i][j],
        `${a.type}/${b.type}`,
      );
      assert.deepEqual(
        conflictingFields(a, { ...b, entityId: crypto.randomUUID() }),
        [],
      );
    }
  assert.deepEqual(
    conflictingFields(
      ops[1],
      f.operation("UPDATE_ITEM", f.itemId, { description: "Description" }),
    ),
    [],
  );
});

test("server choice drops only overlapping fields and keeps later compatible edits", async (t) => {
  const f = await setup(t);
  f.store.actions.updateItem(f.itemId, {
    title: "Mine",
    description: "My context",
  });
  f.store.actions.updateItem(f.itemId, { title: "Latest mine" });
  f.store.actions.updateItem(f.itemId, { description: "Latest context" });
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", f.itemId, { title: "Theirs" }),
      crypto.randomUUID(),
    ),
    2,
  );
  assert.equal(conflicts(f).length, 1);
  assert.equal(conflicts(f)[0].clientValues.title, "Latest mine");
  await resolve(f, "server");
  assert.equal(f.store.getSnapshot().items[f.itemId].title, "Theirs");
  assert.equal(
    f.store.getSnapshot().items[f.itemId].description,
    "Latest context",
  );
  assert.deepEqual(f.store.getSnapshot().pendingOperations[0].payload, {
    description: "Latest context",
  });
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[f.itemId].title, "Theirs");
  assert.equal(f.server().items[f.itemId].description, "Latest context");
});

test("keep mine creates a new identity and current base, with durable resolution history", async (t) => {
  const f = await setup(t);
  f.store.actions.updateItem(f.itemId, { title: "Mine" });
  const old = f.store.getSnapshot().pendingOperations[0];
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", f.itemId, { title: "Theirs" }),
      crypto.randomUUID(),
    ),
    2,
  );
  await resolve(f, "mine");
  const op = f.store.getSnapshot().pendingOperations[0];
  assert.notEqual(op.id, old.id);
  assert.equal(op.baseVersion, 2);
  assert.equal(op.payload.title, "Mine");
  f.db.close();
  await f.db.open();
  const saved = await f.repository.getWorkspace(f.workspaceId);
  assert.equal(saved.syncMetadata.conflicts[0].resolution, "mine");
  assert.equal(saved.syncMetadata.conflicts[0].replacementOperationId, op.id);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[f.itemId].title, "Mine");
});

test("move versus move records both destinations and can use the server destination", async (t) => {
  const f = await setup(t),
    anchor = f.create("Anchor");
  await f.store.sync.apply(f.accept(anchor), 2);
  f.store.actions.moveItem({
    itemId: f.itemId,
    stageId: f.otherStage,
    beforeItemId: null,
  });
  await f.store.sync.apply(
    f.accept(
      f.operation("MOVE_ITEM", f.itemId, {
        stageId: f.stageId,
        beforeItemId: null,
      }),
      crypto.randomUUID(),
    ),
    3,
  );
  const c = conflicts(f)[0];
  assert.deepEqual(c.fields, ["move"]);
  assert.equal(c.clientValues.move, f.otherStage);
  assert.equal(c.serverValues.move, f.stageId);
  await resolve(f, "server");
  assert.equal(f.store.getSnapshot().items[f.itemId].stageId, f.stageId);
  assert.deepEqual(
    f.store.getSnapshot().itemOrderByStage,
    f.server().itemOrderByStage,
  );
});

for (const choice of ["mine", "server"])
  test(`remote deletion preserves offline edits and resolves with ${choice}`, async (t) => {
    const f = await setup(t);
    f.store.actions.updateItem(f.itemId, {
      description: "Offline notes that must survive",
    });
    await f.store.sync.apply(
      f.accept(f.operation("DELETE_ITEM", f.itemId, null), crypto.randomUUID()),
      2,
    );
    assert.equal(
      f.store.getSnapshot().items[f.itemId].description,
      "Offline notes that must survive",
    );
    f.db.close();
    await f.db.open();
    const saved = await f.repository.getWorkspace(f.workspaceId);
    assert.equal(saved.syncMetadata.conflicts[0].serverEntity, null);
    const restored = createWorkspaceStore({
      savedWorkspace: saved,
      repository: f.repository,
    });
    await restored.persistence.initialize();
    const c = unresolvedConflicts(restored.getSnapshot().syncMetadata)[0];
    await restored.sync.resolve(c.id, choice, c.serverWorkspaceVersion);
    f.start({}, restored);
    await until(() => restored.getSnapshot().syncPhase === "synced");
    assert.equal(f.server().items[f.itemId], undefined);
    const items = Object.values(f.server().items);
    assert.equal(items.length, choice === "mine" ? 1 : 0);
    if (choice === "mine")
      assert.equal(items[0].description, "Offline notes that must survive");
  });

test("one conflicted entity and its anchor dependents pause; unrelated work uploads", async (t) => {
  const f = await setup(t),
    b = f.create("B"),
    c = f.create("C");
  await f.store.sync.apply(f.accept(b), 2);
  await f.store.sync.apply(f.accept(c), 3);
  f.store.actions.updateItem(f.itemId, { title: "A local" });
  f.store.actions.moveItem({
    itemId: b.entityId,
    stageId: f.stageId,
    beforeItemId: f.itemId,
  });
  f.store.actions.updateItem(b.entityId, {
    description: "Depends on B's move",
  });
  f.store.actions.updateItem(c.entityId, { description: "Independent work" });
  f.accept(
    f.operation("UPDATE_ITEM", f.itemId, { title: "A remote" }),
    crypto.randomUUID(),
  );
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "conflict");
  assert.equal(f.server().items[c.entityId].description, "Independent work");
  assert.equal(f.server().items[b.entityId].description, "");
  assert.equal(f.store.getSnapshot().pendingOperations.length, 3);
  assert.equal(
    nextUpload(f.store.getSnapshot().pendingOperations, conflicts(f)),
    undefined,
  );
  assert.equal(
    f.store.actions.updateItem(f.itemId, { title: "Blocked" }),
    false,
  );
  assert.equal(
    f.store.actions.updateItem(c.entityId, { title: "Still editable" }),
    true,
  );
  await until(() => f.server().items[c.entityId].title === "Still editable");
  await until(
    () =>
      f.store.getSnapshot().syncPhase === "conflict" &&
      f.store.getSnapshot().pendingOperations.length === 3,
  );
  await resolve(f, "server");
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[b.entityId].description, "Depends on B's move");
});

test("a fresh resolution rejected by another edit becomes a new conflict with the newest values", async (t) => {
  const f = await setup(t);
  f.store.actions.updateItem(f.itemId, { title: "Mine" });
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", f.itemId, { title: "B first" }),
      crypto.randomUUID(),
    ),
    2,
  );
  const first = conflicts(f)[0].id;
  await resolve(f, "mine");
  let submitted;
  const stop = f.start({
    submit: async (op) => {
      submitted = op;
      f.accept(
        f.operation("UPDATE_ITEM", f.itemId, { title: "B newest" }, 2),
        crypto.randomUUID(),
      );
      return f.options.submit(op);
    },
  });
  await until(() => f.store.getSnapshot().syncPhase === "conflict");
  stop();
  const c = conflicts(f)[0];
  assert.notEqual(c.id, first);
  assert.equal(c.operationId, submitted.id);
  assert.equal(c.clientValues.title, "Mine");
  assert.equal(c.serverValues.title, "B newest");
  assert.equal(c.serverEntityVersion, 3);
  assert.equal(f.server().items[f.itemId].title, "B newest");
  await resolve(f, "mine");
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[f.itemId].title, "Mine");
  assert.equal(f.server().items[f.itemId].version, 4);
});

test("a failed resolution transaction retains both the conflict and original queue", async (t) => {
  const f = await setup(t);
  f.store.actions.updateItem(f.itemId, { title: "Mine" });
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", f.itemId, { title: "Theirs" }),
      crypto.randomUUID(),
    ),
    2,
  );
  const before = await f.repository.getWorkspace(f.workspaceId);
  const fail = () => {
    throw new DOMException("Full", "QuotaExceededError");
  };
  f.db.workspaceSyncMetadata.hook("updating", fail);
  await assert.rejects(resolve(f, "mine"), { name: "QuotaExceededError" });
  f.db.workspaceSyncMetadata.hook("updating").unsubscribe(fail);
  assert.deepEqual(await f.repository.getWorkspace(f.workspaceId), before);
});

test("multiple conflicts survive database restart and resolve independently", async (t) => {
  const f = await setup(t),
    b = f.create("B");
  await f.store.sync.apply(f.accept(b), 2);
  for (const id of [f.itemId, b.entityId])
    f.store.actions.updateItem(id, { title: `Local ${id}` });
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", f.itemId, { title: "Remote A" }),
      crypto.randomUUID(),
    ),
    3,
  );
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", b.entityId, { title: "Remote B" }),
      crypto.randomUUID(),
    ),
    4,
  );
  f.db.close();
  await f.db.open();
  assert.equal(
    unresolvedConflicts(
      (await f.repository.getWorkspace(f.workspaceId)).syncMetadata,
    ).length,
    2,
  );
  await resolve(f, "server");
  assert.equal(conflicts(f).length, 1);
  await resolve(f, "mine");
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
});

test("snapshot recovery preserves field bases and lets server merge disjoint edits", async (t) => {
  const f = await setup(t);
  f.store.actions.updateItem(f.itemId, { description: "Mine" });
  f.accept(
    f.operation("UPDATE_ITEM", f.itemId, { title: "Theirs" }),
    crypto.randomUUID(),
  );
  f.pruneBefore(2);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[f.itemId].title, "Theirs");
  assert.equal(f.server().items[f.itemId].description, "Mine");
});

test("unrelated typing during a resolution commit stays durable with the next local revision", async (t) => {
  const f = await setup(t),
    b = f.create("B");
  await f.store.sync.apply(f.accept(b), 2);
  f.store.actions.updateItem(f.itemId, { title: "Mine" });
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", f.itemId, { title: "Theirs" }),
      crypto.randomUUID(),
    ),
    3,
  );
  let once = false;
  const type = () => {
    if (!once) {
      once = true;
      f.store.actions.updateItem(b.entityId, {
        description: "Typed while resolving A",
      });
    }
  };
  f.db.workspaceSyncMetadata.hook("updating", type);
  await resolve(f, "server");
  f.db.workspaceSyncMetadata.hook("updating").unsubscribe(type);
  await f.store.persistence.flush();
  assert.equal(f.store.getSnapshot().storageError, null);
  assert.equal(
    (await f.repository.getWorkspace(f.workspaceId)).items[b.entityId]
      .description,
    "Typed while resolving A",
  );
  assert.equal(f.store.getSnapshot().uploadedCount, 0);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
});

test("local deletion versus remote edit remains discoverable and accepting server preserves compatible local notes", async (t) => {
  const f = await setup(t);
  f.store.actions.updateItem(f.itemId, {
    title: "My title",
    description: "Compatible notes",
  });
  f.store.actions.deleteItem(f.itemId);
  await f.store.sync.apply(
    f.accept(
      f.operation("UPDATE_ITEM", f.itemId, { title: "Their title" }),
      crypto.randomUUID(),
    ),
    2,
  );
  assert.ok(f.store.getSnapshot().items[f.itemId]);
  assert.ok(conflicts(f)[0].fields.includes("delete"));
  await resolve(f, "server");
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[f.itemId].title, "Their title");
  assert.equal(f.server().items[f.itemId].description, "Compatible notes");
});

test("renames conflict only with the same stage and keep mine sends a new rename", async (t) => {
  const f = await setup(t);
  f.store.actions.renameStage(f.stageId, "My stage");
  await f.store.sync.apply(
    f.accept(
      f.operation("MOVE_ITEM", f.itemId, {
        stageId: f.otherStage,
        beforeItemId: null,
      }),
      crypto.randomUUID(),
    ),
    2,
  );
  assert.equal(conflicts(f).length, 0);
  await f.store.sync.apply(
    f.accept(
      f.operation("RENAME_STAGE", f.stageId, { name: "Their stage" }, 0),
      crypto.randomUUID(),
    ),
    3,
  );
  assert.equal(conflicts(f)[0].clientValues.name, "My stage");
  await resolve(f, "mine");
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().stages[f.stageId].name, "My stage");
});

test("snapshot recovery of a merged lost acknowledgment never rebases a conflicting successor past unseen edits", async (t) => {
  const f = await setup(t);
  f.store.actions.updateItem(f.itemId, { title: "My title" });
  f.store.actions.updateItem(f.itemId, { description: "My later notes" });
  await f.store.persistence.flush();
  f.accept(
    f.operation("UPDATE_ITEM", f.itemId, {
      description: "Unseen remote notes",
    }),
    crypto.randomUUID(),
  );
  f.accept(f.store.getSnapshot().pendingOperations[0]);
  f.pruneBefore(3);
  f.start();
  await until(() => f.store.getSnapshot().syncPhase === "conflict");
  assert.equal(f.server().items[f.itemId].description, "Unseen remote notes");
  assert.equal(conflicts(f)[0].clientValues.description, "My later notes");
  assert.equal(conflicts(f)[0].serverValues.description, "Unseen remote notes");
  assert.equal(f.store.getSnapshot().pendingOperations[0].baseVersion, 1);
});
