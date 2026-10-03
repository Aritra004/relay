import assert from "node:assert/strict";
import { test } from "node:test";
import { syncFixture, until } from "./sync-test-helpers.mjs";
import { startWorkspaceRealtime } from "./workspace-realtime.ts";
import { acceptedEvent } from "./realtime-contract.ts";
import { RealtimeError } from "./realtime-http.ts";

async function liveFixture(t, overrides = {}) {
  const f = await syncFixture(t);
  const sync = f.start(overrides);
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  let receive,
    disconnect,
    aborted = 0,
    connections = 0;
  const consume = async (_workspace, _cursor, _account, signal, callback) => {
    connections++;
    receive = callback;
    callback({
      type: "stream.ready",
      workspaceId: f.workspaceId,
      serverVersion: f.log.length,
    });
    await new Promise((resolve) => {
      disconnect = resolve;
      signal.addEventListener(
        "abort",
        () => {
          aborted++;
          resolve();
        },
        { once: true },
      );
    });
  };
  const stop = startWorkspaceRealtime(f.store, sync, {
    consume,
    retryDelay: () => 10,
  });
  t.after(stop);
  await until(
    () =>
      receive &&
      !f.store.getSnapshot().realtime.catchUpRequired &&
      f.store.getSnapshot().syncPhase === "synced",
  );
  return {
    ...f,
    sync,
    stop,
    send: (event) => receive(event),
    disconnect: () => disconnect(),
    connections: () => connections,
    aborted: () => aborted,
  };
}

test("idle live operations apply once through durable sync; five duplicates have no effects", async (t) => {
  const f = await liveFixture(t);
  const remote = f.accept(f.create(), crypto.randomUUID());
  for (let i = 0; i < 5; i++) f.send(acceptedEvent(remote));
  await until(
    () =>
      f.store.getSnapshot().syncPhase === "synced" &&
      f.store.getSnapshot().syncMetadata.confirmedServerVersion === 1,
  );
  const revision = f.store.getSnapshot().syncMetadata.localRevision;
  const change = f.store.getSnapshot().remoteChanges[remote.operation.entityId];
  for (let i = 0; i < 5; i++) f.send(acceptedEvent(remote));
  assert.equal(f.store.getSnapshot().syncMetadata.localRevision, revision);
  assert.equal(
    f.store.getSnapshot().remoteChanges[remote.operation.entityId],
    change,
  );
  assert.equal(
    (await f.repository.getWorkspace(f.workspaceId)).items[
      remote.operation.entityId
    ].title,
    "Remote",
  );
  assert.equal(f.store.getSnapshot().syncMetadata.receivedRemoteOperations, 1);
});

test("out-of-order delivery and gaps fetch ordered history before consuming live state", async (t) => {
  const f = await liveFixture(t);
  const first = f.accept(f.create("First"), crypto.randomUUID());
  const second = f.accept(f.create("Second"), crypto.randomUUID());
  f.events.length = 0;
  f.send(acceptedEvent(second));
  assert.equal(f.store.getSnapshot().realtime.catchUpRequired, true);
  f.send(acceptedEvent(first));
  await until(
    () =>
      f.store.getSnapshot().syncMetadata.confirmedServerVersion === 2 &&
      !f.store.getSnapshot().realtime.catchUpRequired,
  );
  assert.equal(f.events[0], "pull:0");
  assert.deepEqual(
    f.store.getSnapshot().itemOrderByStage,
    f.server().itemOrderByStage,
  );
});

test("a checkpoint recovers a missed final message without waiting for another edit", async (t) => {
  const f = await liveFixture(t);
  f.accept(f.create("Dropped"), crypto.randomUUID());
  f.send({
    type: "stream.checkpoint",
    workspaceId: f.workspaceId,
    serverVersion: 1,
  });
  await until(
    () => f.store.getSnapshot().syncMetadata.confirmedServerVersion === 1,
  );
  assert.equal(Object.values(f.store.getSnapshot().items)[0].title, "Dropped");
});

test("own accepted echo retires a pending create without duplicating or highlighting it", async (t) => {
  const f = await liveFixture(t);
  f.store.actions.createItem("Mine", f.stageId);
  const op = f.store.getSnapshot().pendingOperations[0];
  f.store.sync.editing(op.entityId);
  await f.store.persistence.flush();
  f.send(acceptedEvent(f.accept(op)));
  await until(() => f.store.getSnapshot().pendingOperations.length === 0);
  assert.equal(Object.keys(f.store.getSnapshot().items).length, 1);
  assert.equal(f.store.getSnapshot().remoteChanges[op.entityId], undefined);
  assert.equal(
    f.events.some((event) => event.startsWith("push:")),
    false,
  );
});

test("focused text stays durable through compatible live moves and conflicting remote edits", async (t) => {
  const f = await liveFixture(t),
    author = crypto.randomUUID();
  const create = f.create();
  f.send(acceptedEvent(f.accept(create, author)));
  await until(
    () => f.store.getSnapshot().syncMetadata.confirmedServerVersion === 1,
  );
  f.store.sync.editing(create.entityId);
  f.store.actions.updateItem(create.entityId, { title: "Still typing" });
  await f.store.persistence.flush();
  f.send(
    acceptedEvent(
      f.accept(
        f.operation(
          "MOVE_ITEM",
          create.entityId,
          { stageId: f.otherStage, beforeItemId: null },
          1,
        ),
        author,
      ),
    ),
  );
  await until(
    () => f.store.getSnapshot().syncMetadata.confirmedServerVersion === 2,
  );
  assert.equal(
    f.store.getSnapshot().items[create.entityId].title,
    "Still typing",
  );
  assert.equal(
    f.store.getSnapshot().items[create.entityId].stageId,
    f.otherStage,
  );
  assert.equal(
    f.events.some((event) => event.startsWith("push:")),
    false,
  );
  f.send(
    acceptedEvent(
      f.accept(
        f.operation(
          "UPDATE_ITEM",
          create.entityId,
          { title: "Their title" },
          2,
        ),
        author,
      ),
    ),
  );
  await until(() => f.store.getSnapshot().syncPhase === "conflict");
  const saved = await f.repository.getWorkspace(f.workspaceId);
  assert.equal(saved.items[create.entityId].title, "Still typing");
  assert.equal(
    saved.syncMetadata.conflicts.filter((c) => c.status === "unresolved")
      .length,
    1,
  );
  assert.equal(
    f.events.some((event) => event.startsWith("push:")),
    false,
  );
});

test("leaving a focused field uploads its saved edits", async (t) => {
  const f = await liveFixture(t);
  const remote = f.accept(f.create(), crypto.randomUUID());
  f.send(acceptedEvent(remote));
  await until(
    () => f.store.getSnapshot().syncMetadata.confirmedServerVersion === 1,
  );
  f.store.sync.editing(remote.operation.entityId);
  f.store.actions.updateItem(remote.operation.entityId, { title: "Finished" });
  await f.store.persistence.flush();
  await until(() => f.store.getSnapshot().syncPhase === "idle");
  assert.equal(f.store.getSnapshot().pendingOperations.length, 1);
  f.store.sync.editing(null);
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(f.server().items[remote.operation.entityId].title, "Finished");
});

test("reconnect pulls missed operations before uploading offline work", async (t) => {
  const f = await liveFixture(t);
  f.store.setOnline(false);
  f.store.actions.createItem("Offline", f.stageId);
  await f.store.persistence.flush();
  f.accept(f.create("Missed"), crypto.randomUUID());
  f.events.length = 0;
  f.store.setOnline(true);
  await until(
    () => f.connections() >= 2 && f.store.getSnapshot().syncPhase === "synced",
  );
  assert.equal(f.events[0], "pull:0");
  assert.equal(Object.keys(f.store.getSnapshot().items).length, 2);
});

test("events arriving during an in-flight sync cause another pass, including its final return", async (t) => {
  const f = await syncFixture(t);
  let release,
    wait = false;
  const sync = f.start({
    pull: async (...args) => {
      const page = await f.options.pull(...args);
      if (wait) {
        wait = false;
        await new Promise((resolve) => {
          release = resolve;
        });
      }
      return page;
    },
  });
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  wait = true;
  sync.reconcile();
  await until(() => release);
  const remote = f.accept(f.create("During pull"), crypto.randomUUID());
  sync.receive(remote);
  release();
  await until(
    () => f.store.getSnapshot().syncMetadata.confirmedServerVersion === 1,
  );
  assert.equal(
    f.store.getSnapshot().items[remote.operation.entityId].title,
    "During pull",
  );
});

test("stop aborts the subscription; disposed workspaces ignore late events", async (t) => {
  const f = await liveFixture(t);
  const count = f.connections();
  f.stop();
  f.send(acceptedEvent(f.accept(f.create(), crypto.randomUUID())));
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(f.connections(), count);
  assert.ok(f.aborted() > 0);
  assert.equal(f.store.getSnapshot().realtime.status, "disconnected");
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 0);
});

test("terminal authorization failures stop reconnects and preserve the local workspace", async (t) => {
  const f = await syncFixture(t);
  const sync = f.start();
  let calls = 0;
  const stop = startWorkspaceRealtime(f.store, sync, {
    retryDelay: () => 1,
    consume: async () => {
      calls++;
      throw new RealtimeError("Access revoked", true);
    },
  });
  t.after(stop);
  await until(() => f.store.getSnapshot().realtime.error);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1);
  assert.equal(f.store.getSnapshot().realtime.status, "disconnected");
  assert.ok(await f.repository.getWorkspace(f.workspaceId));
});

test("document pagehide aborts its stream and pageshow resumes one subscription", async (t) => {
  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { value: events, configurable: true });
  t.after(() => Reflect.deleteProperty(globalThis, "window"));
  const f = await liveFixture(t);
  events.dispatchEvent(new Event("pagehide"));
  await until(() => f.aborted() === 1);
  assert.equal(f.store.getSnapshot().realtime.status, "disconnected");
  const count = f.connections();
  await new Promise((r) => setTimeout(r, 30)); assert.equal(f.connections(), count);
  events.dispatchEvent(new Event("pageshow"));
  await until(() => f.connections() === count + 1);
  f.stop();
});
