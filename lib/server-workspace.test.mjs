import "fake-indexeddb/auto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { RelayDatabase } from "./local-db.ts";
import { AccountDatabase, createAccountRegistry } from "./local-account.ts";
import { createWorkspaceRepository } from "./workspace-repository.ts";
import { createServerWorkspace } from "./server-workspace.ts";
import { toLocalSnapshot } from "./server-snapshot.ts";
import { fetchApi, WorkspaceApiError } from "./online-workspace.ts";
import { createWorkspaceStore } from "../components/workspace/workspace-store.ts";

function fixture() {
  const user = { id: crypto.randomUUID(), name: "Alice", email: "alice@example.invalid" };
  const workspaceId = crypto.randomUUID();
  const stageIds = Array.from({ length: 5 }, () => crypto.randomUUID());
  const itemId = crypto.randomUUID();
  const data = {
    workspace: { id: workspaceId, name: "Server workspace", version: 7 }, version: 7,
    stages: stageIds.map((id, position) => ({ id, name: ["IDEA", "PLANNED", "BUILDING", "REVIEW", "SHIPPED"][position], description: "A stage", position, version: 0 })),
    items: [{ id: itemId, title: "From PostgreSQL", description: "Server description", stageId: stageIds[0], position: 0, version: 3, updatedAt: "2026-09-23T10:00:00.000Z" }],
    members: [{ userId: user.id, name: user.name, role: "owner" }],
    membership: { userId: user.id, role: "owner" },
    stageOrder: stageIds,
    itemOrderByStage: Object.fromEntries(stageIds.map((id, index) => [id, index ? [] : [itemId]])),
  };
  return { user, workspaceId, stageIds, itemId, data };
}

async function setup(t) {
  const f = fixture();
  const db = new RelayDatabase(`server-workspace-test-${crypto.randomUUID()}`);
  const identityDb = new AccountDatabase(`account-test-${crypto.randomUUID()}`);
  await db.open(); await identityDb.open();
  t.after(async () => { await db.delete(); await identityDb.delete(); });
  const accounts = createAccountRegistry(identityDb);
  await accounts.remember(f.user);
  const repository = createWorkspaceRepository(async () => db);
  const api = { session: async () => ({ user: f.user }), snapshot: async () => structuredClone(f.data) };
  const create = (overrides = {}) => createServerWorkspace(f.workspaceId, { api: { ...api, ...overrides }, accounts, repositoryFor: () => repository });
  return { ...f, db, accounts, repository, create };
}

const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
function waitFor(controller, predicate) {
  if (predicate(controller.getSnapshot())) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = controller.subscribe(() => { if (predicate(controller.getSnapshot())) { unsubscribe(); resolve(); } });
  });
}

test("server IDs and metadata initialize the existing store, cache and offline mutations", async (t) => {
  const f = await setup(t);
  const first = f.create();
  await first.initialize(true);
  const state = first.getSnapshot();
  assert.equal(state.access, "online");
  assert.equal(state.store.getSnapshot().items[f.itemId].title, "From PostgreSQL");
  assert.deepEqual(state.store.getSnapshot().stageOrder, f.stageIds);
  assert.equal(state.store.getSnapshot().syncMetadata.lastServerVersion, 7);
  assert.equal(state.store.getSnapshot().syncMetadata.lastSyncedAt, null);
  assert.equal((await f.db.workspaces.toArray()).length, 1);
  const offline = f.create({ session: async () => { throw new Error("Offline must not fetch"); } });
  await offline.initialize(false);
  const store = offline.getSnapshot().store;
  assert.equal(offline.getSnapshot().source, "cache");
  assert.equal(store.getSnapshot().syncStatus, "offline");
  const item = store.actions.createItem("Offline creation", f.stageIds[1]);
  store.actions.updateItem(f.itemId, { title: "Offline title" });
  store.actions.moveItem({ itemId: item.id, stageId: f.stageIds[2], beforeItemId: null });
  store.actions.renameStage(f.stageIds[3], "Offline review");
  await store.persistence.flush();
  const before = await f.repository.getWorkspace(f.workspaceId);
  const reopened = f.create();
  await reopened.initialize(false);
  assert.deepEqual(reopened.getSnapshot().store.getSnapshot().pendingOperations, before.pendingOperations);
  assert.equal(reopened.getSnapshot().store.getSnapshot().items[f.itemId].title, "Offline title");
  assert.equal(before.syncMetadata.lastServerVersion, 7);
});

test("pending and in-flight local edits survive a late snapshot and reconnection", async (t) => {
  const f = await setup(t);
  await f.repository.initializeServerWorkspace(toLocalSnapshot(f.data, f.workspaceId, f.user.id));
  const server = deferred();
  const controller = f.create({ snapshot: () => server.promise });
  const opening = controller.initialize(true);
  await waitFor(controller, (state) => Boolean(state.store));
  const store = controller.getSnapshot().store;
  // This edit happens before the network response and must return immediately.
  assert.equal(store.actions.updateItem(f.itemId, { title: "Keep local title" }), true);
  const exactOperations = store.getSnapshot().pendingOperations;
  server.resolve({ ...f.data, items: [{ ...f.data.items[0], title: "New remote title" }] });
  await opening;
  await store.persistence.flush();
  assert.equal(controller.getSnapshot().store, store);
  assert.equal(store.getSnapshot().items[f.itemId].title, "Keep local title");
  assert.deepEqual(store.getSnapshot().pendingOperations, exactOperations);
  const saved = await f.repository.getWorkspace(f.workspaceId);
  assert.equal(saved.items[f.itemId].title, "Keep local title");
  const reconnect = f.create(); await reconnect.initialize(true);
  assert.deepEqual(reconnect.getSnapshot().store.getSnapshot().pendingOperations, exactOperations);
  assert.equal(reconnect.getSnapshot().store.getSnapshot().items[f.itemId].title, "Keep local title");
});

test("initialization is atomic across tabs and never replaces an existing cache", async (t) => {
  const f = await setup(t);
  const snapshot = toLocalSnapshot(f.data, f.workspaceId, f.user.id);
  await Promise.all([f.repository.initializeServerWorkspace(snapshot), f.repository.initializeServerWorkspace(snapshot)]);
  const store = createWorkspaceStore({ savedWorkspace: snapshot, repository: f.repository });
  await store.persistence.initialize();
  store.actions.deleteItem(f.itemId);
  await store.persistence.flush();
  const saved = await f.repository.initializeServerWorkspace(snapshot);
  assert.equal(saved.items[f.itemId], undefined);
  assert.equal(saved.pendingOperations.length, 1);
  assert.equal((await f.db.workspaces.count()), 1);
});

test("unavailable connectivity keeps the live store editable; unknown workspaces are never seeded", async (t) => {
  const f = await setup(t);
  const outage = () => { throw new WorkspaceApiError("unavailable", "Server unavailable", 503); };
  const missing = f.create({ session: outage });
  await missing.initialize(true);
  assert.equal(missing.getSnapshot().store, null);
  assert.equal(await f.db.workspaces.count(), 0);
  await f.repository.initializeServerWorkspace(toLocalSnapshot(f.data, f.workspaceId, f.user.id));
  const cached = f.create({ session: outage });
  await cached.initialize(true);
  assert.equal(cached.getSnapshot().access, "unavailable");
  assert.ok(cached.getSnapshot().store.actions.createItem("Still works", f.stageIds[0]));
  await cached.getSnapshot().store.persistence.flush();
});

test("explicit session rejection blocks access without deleting cached data or the queue", async (t) => {
  const f = await setup(t);
  const first = f.create(); await first.initialize(true);
  first.getSnapshot().store.actions.updateItem(f.itemId, { title: "Pending" });
  await first.getSnapshot().store.persistence.flush();
  const before = await f.repository.getWorkspace(f.workspaceId);
  const rejected = f.create({ session: async () => { throw new WorkspaceApiError("unauthenticated", "Expired", 401); } });
  await rejected.initialize(true);
  assert.equal(rejected.getSnapshot().access, "unauthenticated");
  assert.equal(rejected.getSnapshot().store.getSnapshot().editingBlocked, true);
  assert.deepEqual(await f.repository.getWorkspace(f.workspaceId), before);
  const offline = f.create(); await offline.initialize(false);
  assert.equal(offline.getSnapshot().access, "unauthenticated");
  assert.equal(offline.getSnapshot().store, null);
  const outage = f.create({ session: async () => { throw new WorkspaceApiError("unavailable", "Server unavailable", 503); } });
  await outage.initialize(true);
  assert.equal(outage.getSnapshot().access, "unauthenticated");
  assert.equal(outage.getSnapshot().store, null);
});

test("membership rejection persists across an offline reload and cannot be bypassed by network failure", async (t) => {
  const f = await setup(t);
  const first = f.create(); await first.initialize(true);
  const denied = f.create({ snapshot: async () => { throw new WorkspaceApiError("forbidden", "No access", 404); } });
  await denied.initialize(true);
  assert.equal(denied.getSnapshot().access, "forbidden");
  const offline = f.create(); await offline.initialize(false);
  assert.equal(offline.getSnapshot().access, "forbidden");
  assert.equal(offline.getSnapshot().store.actions.updateItem(f.itemId, { title: "Denied" }), false);
  const restored = f.create(); await restored.initialize(true);
  assert.equal(restored.getSnapshot().access, "online");
  assert.equal(restored.getSnapshot().store.getSnapshot().editingBlocked, false);
});

test("sign-out in another tab blocks further edits but keeps pending changes", async (t) => {
  const f = await setup(t);
  const controller = f.create(); await controller.initialize(true);
  const unsubscribe = controller.watchAccount(); t.after(unsubscribe);
  const store = controller.getSnapshot().store;
  store.actions.updateItem(f.itemId, { title: "Before logout" });
  await store.persistence.flush();
  const blocked = waitFor(controller, (state) => state.access === "unauthenticated");
  await f.accounts.signOut(); await blocked;
  assert.equal(store.actions.updateItem(f.itemId, { title: "After logout" }), false);
  assert.equal((await f.repository.getWorkspace(f.workspaceId)).items[f.itemId].title, "Before logout");
});

test("old in-flight session results cannot restore an account after sign-out", async (t) => {
  const f = await setup(t);
  const late = deferred();
  const requested = deferred();
  const controller = f.create({ session: () => { requested.resolve(); return late.promise; } });
  const opening = controller.initialize(true);
  await requested.promise;
  await f.accounts.signOut();
  late.resolve({ user: f.user });
  await opening;
  assert.equal((await f.accounts.read()).status, "signed-out");
  assert.equal(controller.getSnapshot().store, null);
  assert.equal(controller.getSnapshot().access, "unauthenticated");
});

test("snapshot validation rejects wrong identities, duplicates and broken ordering before writing", () => {
  const f = fixture();
  for (const invalid of [
    { ...f.data, membership: { userId: crypto.randomUUID(), role: "owner" } },
    { ...f.data, items: [...f.data.items, ...f.data.items] },
    { ...f.data, stageOrder: ["__proto__"] },
    { ...f.data, version: 99 },
    { ...f.data, itemOrderByStage: { ...f.data.itemOrderByStage, [f.stageIds[0]]: [] } },
  ]) assert.throws(() => toLocalSnapshot(invalid, f.workspaceId, f.user.id), WorkspaceApiError);
});

test("API errors distinguish authentication from connection failure and unreadable responses", async (t) => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original; });
  for (const [status, kind] of [[401, "unauthenticated"], [403, "forbidden"], [404, "forbidden"], [503, "unavailable"], [429, "unavailable"]]) {
    globalThis.fetch = async () => new Response("not json", { status });
    await assert.rejects(fetchApi("/api/session"), (error) => error instanceof WorkspaceApiError && error.kind === kind);
  }
  globalThis.fetch = async () => { throw new TypeError("Network error"); };
  await assert.rejects(fetchApi("/api/session"), (error) => error.kind === "unavailable");
  globalThis.fetch = async () => new Response("not json", { status: 200 });
  await assert.rejects(fetchApi("/api/session"), (error) => error.kind === "invalid-response");
});
