import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { performance } from "node:perf_hooks";
import { Dexie } from "dexie";
import { syncFixture, until } from "./sync-test-helpers.mjs";
import { RelayDatabase } from "./local-db.ts";
import { createWorkspaceStore, selectBoard } from "../components/workspace/workspace-store.ts";
import { getSyncSnapshot } from "../components/workspace/sync-inspector-data.ts";
import { startWorkspacePresence } from "./workspace-presence.ts";
import { OperationUploadError } from "./operation-upload-http.ts";
import { conflictContext, recordConflict } from "./conflicts.ts";

test("corrupt entities recover from a snapshot without losing pending work; invalid metadata stops recovery", async (t) => {
  const f = await syncFixture(t);
  const item = f.store.actions.createItem("Unsynced work", f.stageId);
  await f.store.persistence.flush();
  const queue = (await f.repository.getWorkspace(f.workspaceId)).pendingOperations;
  const generation = (await f.repository.getWorkspace(f.workspaceId)).syncMetadata.localGeneration;
  await f.db.workItems.update([f.workspaceId, item.id], { version: -100, title: { malformed: true } });
  await assert.rejects(f.repository.getWorkspace(f.workspaceId), /Invalid workspace item/);
  const recovered = await f.repository.recoverServerWorkspace(await f.options.snapshot());
  assert.deepEqual(recovered.pendingOperations, queue);
  assert.notEqual(recovered.syncMetadata.localGeneration, generation);
  assert.equal(recovered.syncMetadata.serverAccess, "authorized");
  assert.equal(recovered.items[item.id].title, "Unsynced work");
  assert.equal(await f.db.recoveryBackups.count(), 1);
  const backup = (await f.repository.exportRecovery(f.workspaceId)).backups[0];
  assert.deepEqual(backup.data.items[0].title, { malformed: true });
  await f.db.workspaceSyncMetadata.update(f.workspaceId, { confirmedServerVersion: -1 });
  await assert.rejects(f.repository.recoverServerWorkspace(await f.options.snapshot()), /Invalid workspace sync metadata/);
  assert.deepEqual((await f.repository.exportRecovery(f.workspaceId)).pendingOperations.map((stored) => { const op = { ...stored }; delete op.sequence; return op; }), queue);
});

test("v4 to v5 migration preserves every row including pending operations, conflicts, and metadata", async (t) => {
  const f = await syncFixture(t);
  const item = f.store.actions.createItem("Pending upgrade", f.stageId);
  await f.store.persistence.flush();
  const raw = await f.repository.exportRecovery(f.workspaceId);
  const name = `relay-upgrade-${crypto.randomUUID()}`;
  const old = new Dexie(name);
  old.version(4).stores({ workspaces: "id", workflowStages: "[workspaceId+id], workspaceId", workItems: "[workspaceId+id], workspaceId, [workspaceId+stageId]", pendingOperations: "id, workspaceId, &[workspaceId+sequence]", workspaceSyncMetadata: "workspaceId", confirmedWorkspaces: "id" });
  await old.open();
  const [conflict] = recordConflict([], conflictContext(f.store.getSnapshot().pendingOperations[0], f.seed, 0, ["history"]), f.store.getSnapshot());
  assert.equal(conflict.entityId, item.id);
  await old.table("workspaces").put(raw.workspace);
  await old.table("workflowStages").bulkPut(raw.stages);
  await old.table("workItems").bulkPut(raw.items);
  await old.table("pendingOperations").bulkPut(raw.pendingOperations);
  await old.table("workspaceSyncMetadata").put({ ...raw.syncMetadata, conflicts: [conflict] });
  await old.table("confirmedWorkspaces").put(raw.confirmed);
  const before = Object.fromEntries(await Promise.all(old.tables.map(async (table) => [table.name, await table.toArray()])));
  old.close();
  const upgraded = new RelayDatabase(name); t.after(() => upgraded.delete()); await upgraded.open();
  for (const [name, records] of Object.entries(before)) assert.deepEqual(await upgraded.table(name).toArray(), records);
  assert.equal(await upgraded.recoveryBackups.count(), 0);
});

test("archived lost acknowledgment survives refresh and recovers without duplicating accepted work", async (t) => {
  const f = await syncFixture(t);
  f.store.actions.createItem("Lost acknowledgment", f.stageId); await f.store.persistence.flush();
  const op = f.store.getSnapshot().pendingOperations[0]; await f.store.sync.markSubmitted(op);
  const accepted = f.accept(op); f.accept(f.create("Later collaborator work"), crypto.randomUUID()); f.pruneBefore(2);
  const restored = createWorkspaceStore({ savedWorkspace: await f.repository.getWorkspace(f.workspaceId), repository: f.repository });
  await restored.persistence.initialize();
  f.start({ receipt: async () => ({ archived: f.ack(accepted) }) }, restored);
  await until(() => restored.getSnapshot().syncPhase === "synced");
  assert.equal(f.log.length, 2);
  assert.equal(restored.getSnapshot().pendingOperations.length, 0);
  assert.equal(restored.getSnapshot().syncMetadata.confirmedServerVersion, 2);
});

test("reconnect storm never overlaps a sync run and preserves the original operation identity", async (t) => {
  const f = await syncFixture(t);
  let inFlight = 0, maximum = 0;
  const stop = f.start({ pull: async (...args) => { maximum = Math.max(maximum, ++inFlight); try { await new Promise((r) => setTimeout(r, 20)); return await f.options.pull(...args); } finally { inFlight--; } } });
  const item = f.store.actions.createItem("Storm-safe", f.stageId); await f.store.persistence.flush();
  for (let i = 0; i < 20; i++) { f.store.setOnline(false); f.store.setOnline(true); f.store.sync.request(); }
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(maximum, 1); assert.equal(f.log.filter((op) => op.operation.entityId === item.id).length, 1); stop();
});

test("presence heartbeat is throttled, ephemeral, and stops on offline/unmount", async (t) => {
  const f = await syncFixture(t); f.store.realtime.update({ status: "connected" });
  let posts = 0, deletes = 0;
  const stop = startWorkspacePresence(f.store, { heartbeatMs: 50, fetcher: async (_url, options) => {
    if (options.method === "DELETE") deletes++; else posts++;
    return Response.json({ workspaceId: f.workspaceId, serverTime: new Date().toISOString(), members: [] });
  } });
  for (let i = 0; i < 100; i++) f.store.presence.editing(crypto.randomUUID());
  assert.equal(posts, 1);
  assert.equal((await f.repository.exportRecovery(f.workspaceId)).presence, undefined);
  f.store.setOnline(false); const count = posts;
  await new Promise((r) => setTimeout(r, 90)); assert.equal(posts, count);
  stop(); assert.equal(deletes, 1);
});

for (const count of [100, 500, 1000]) test(`${count} items restore, filter, move and inspect without an unbounded activity list`, async (t) => {
  const f = await syncFixture(t);
  const input = structuredClone(f.seed);
  for (let i = 0; i < count; i++) {
    const id = crypto.randomUUID(); input.items[id] = { id, stageId: f.stageId, title: `Portfolio item ${i}`, description: "A realistic short description for the stress workspace.", version: 1, assignee: "You", label: "Engineering", updated: "Just now" };
    input.itemOrderByStage[f.stageId].push(id);
  }
  const started = performance.now(); await f.repository.saveWorkspace(input);
  const restored = createWorkspaceStore({ savedWorkspace: input, repository: f.repository }); await restored.persistence.initialize();
  assert.equal(selectBoard(restored.getSnapshot()).flatMap((lane) => lane.items).length, count);
  assert.equal(selectBoard(restored.getSnapshot(), { query: "Portfolio item 99" }).flatMap((lane) => lane.items).length, count === 1000 ? 11 : 1);
  restored.actions.moveItem({ itemId: Object.keys(input.items)[0], stageId: f.otherStage, beforeItemId: null }); await restored.persistence.flush();
  const state = restored.getSnapshot();
  const huge = { ...state, pendingOperations: Array.from({ length: 1000 }, () => state.pendingOperations[0]) };
  assert.equal(getSyncSnapshot(huge).activity.length, 100);
  assert.equal(getSyncSnapshot(huge).pendingCount, 1000);
  t.diagnostic(`restore + filter + durable move + inspector: ${Math.round(performance.now() - started)}ms`);
});

test("exhausted temporary retries restart on reconnect while the durable operation identity stays unchanged", async (t) => {
  const f = await syncFixture(t);
  f.store.actions.createItem("Retry after outage", f.stageId); await f.store.persistence.flush();
  const original = f.store.getSnapshot().pendingOperations[0];
  let available = false, attempts = 0;
  f.start({ submit: async (op) => { attempts++; assert.equal(op.id, original.id); if (!available) throw new OperationUploadError("temporary", "HTTP_500", "Temporary server outage"); return f.options.submit(op); } });
  await until(() => f.store.getSnapshot().syncMetadata.uploadFailure?.attempts === 5);
  assert.equal((await f.repository.getWorkspace(f.workspaceId)).pendingOperations[0].id, original.id);
  f.store.setOnline(false); available = true; f.store.setOnline(true);
  await until(() => f.store.getSnapshot().syncPhase === "synced");
  assert.equal(attempts, 6); assert.equal(f.log.length, 1);
});

test("hundreds of missed operations replay in bounded ordered pages while local intent survives", async (t) => {
  const f = await syncFixture(t);
  for (let i = 0; i < 250; i++) f.accept(f.create(`Missed ${i}`), crypto.randomUUID());
  f.store.actions.createItem("Offline work survives catch-up", f.otherStage); await f.store.persistence.flush();
  let largest = 0;
  const started = performance.now();
  f.start({ pull: async (...args) => { const page = await f.options.pull(...args); largest = Math.max(largest, page.operations?.length ?? 0); return page; } });
  const deadline = Date.now() + 30_000;
  while (f.store.getSnapshot().syncPhase !== "synced" && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.store.getSnapshot().syncPhase, "synced");
  assert.equal(largest, 100); assert.equal(Object.keys(f.store.getSnapshot().items).length, 251);
  assert.equal(f.store.getSnapshot().syncMetadata.confirmedServerVersion, 251);
  assert.equal(f.store.getSnapshot().pendingOperations.length, 0);
  assert.ok(f.events.indexOf("pull:200") < f.events.findIndex((event) => event.startsWith("push:")));
  t.diagnostic(`250-operation catch-up plus local upload: ${Math.round(performance.now() - started)}ms`);
});

test("a corrupt frozen submission never reaches the network and remains recoverable", async (t) => {
  const f = await syncFixture(t);
  f.store.actions.createItem("Preserve corrupt metadata evidence", f.stageId); await f.store.persistence.flush();
  const op = f.store.getSnapshot().pendingOperations[0];
  await f.db.workspaceSyncMetadata.update(f.workspaceId, { submittedOperation: { ...op, workspaceId: crypto.randomUUID() } });
  let uploads = 0; f.start({ submit: async () => { uploads++; throw new Error("Must not upload"); } });
  await until(() => f.store.getSnapshot().storageError);
  assert.equal(uploads, 0);
  assert.equal((await f.repository.exportRecovery(f.workspaceId)).pendingOperations[0].id, op.id);
});
