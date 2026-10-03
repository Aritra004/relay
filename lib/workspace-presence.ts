import type { WorkspaceStore } from "../components/workspace/workspace-store.ts";
import { PRESENCE_HEARTBEAT_MS, PRESENCE_TTL_MS, presenceResponseSchema } from "./presence-contract.ts";

export function startWorkspacePresence(store: WorkspaceStore, { fetcher = fetch, heartbeatMs = PRESENCE_HEARTBEAT_MS, now = Date.now }: { fetcher?: typeof fetch; heartbeatMs?: number; now?: () => number } = {}) {
  const clientId = crypto.randomUUID(); // Unique per mounted tab, never durable.
  let stopped = false, suspended = false;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let serverOffset = 0;
  const eligible = () => {
    const s = store.getSnapshot();
    return !stopped && !suspended && s.workspace.source === "server" && s.restoration === "ready" && s.syncStatus !== "offline" && !s.editingBlocked && !s.storageError && s.realtime.status === "connected";
  };
  const body = (leave = false) => {
    const s = store.getSnapshot();
    return JSON.stringify({ clientId, editingItemId: !leave && s.presence.activeUntil > now() ? s.presence.editingItemId : null });
  };
  const options = () => ({
    url: `/api/workspaces/${encodeURIComponent(store.getSnapshot().workspace.id)}/presence`,
    headers: { "Content-Type": "application/json", "X-Relay-Account-ID": store.getSnapshot().workspace.cachedForUserId! },
  });
  function schedule() {
    if (!eligible() || timer !== undefined || request) return;
    timer = setTimeout(() => { timer = undefined; void heartbeat(); }, heartbeatMs);
  }
  async function heartbeat() {
    if (!eligible() || request) return;
    const controller = new AbortController();
    request = controller;
    const { url, headers } = options();
    try {
      const response = await fetcher(url, { method: "POST", headers, body: body(), credentials: "same-origin", cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw new Error("Presence is reconnecting. Your changes are saved separately.");
      const result = presenceResponseSchema.parse(await response.json());
      if (!eligible() || controller.signal.aborted) return;
      if (result.workspaceId !== store.getSnapshot().workspace.id || result.members.some((m) => m.workspaceId !== result.workspaceId)) throw new Error("Invalid presence response.");
      serverOffset = Date.parse(result.serverTime) - now();
      store.presence.update({ members: result.members, updatedAt: new Date(now()).toISOString(), error: null });
    } catch {
      if (!stopped && !controller.signal.aborted) store.presence.update({ error: "Presence is reconnecting. Your changes are saved separately." });
    } finally {
      request = undefined;
      schedule();
    }
  }
  function leave() {
    const s = store.getSnapshot();
    if (s.workspace.source !== "server") return;
    const { url, headers } = options();
    // Best effort only: expiry is authoritative when pagehide cannot run.
    void fetcher(url, { method: "DELETE", headers, body: body(true), credentials: "same-origin", keepalive: true }).catch(() => {});
  }
  let wasEligible = false;
  const update = () => {
    const active = eligible();
    if (active === wasEligible) return;
    wasEligible = active;
    if (active) void heartbeat();
    else {
      request?.abort();
      clearTimeout(timer); timer = undefined;
      if (store.getSnapshot().syncStatus === "offline" || store.getSnapshot().editingBlocked) store.presence.update({ members: [] });
    }
  };
  const unsubscribe = store.subscribe(update);
  // Expire stale responses locally too, including when heartbeats fail silently.
  const expiry = setInterval(() => {
    const members = store.getSnapshot().presence.members;
    const time = now() + serverOffset;
    if (members.some((m) => (m.status === "online" && time - Date.parse(m.lastSeen) >= PRESENCE_TTL_MS) || (m.editingItemId && time - Date.parse(m.lastSeen) >= 20_000)))
      store.presence.update({ members: members.map((m) => time - Date.parse(m.lastSeen) >= PRESENCE_TTL_MS ? { ...m, status: "offline", editingItemId: null } : time - Date.parse(m.lastSeen) >= 20_000 ? { ...m, editingItemId: null } : m) });
  }, 1000);
  const hide = () => { suspended = true; update(); leave(); };
  const show = () => { suspended = false; update(); };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
  }
  update();
  return () => {
    stopped = true; unsubscribe(); request?.abort(); clearTimeout(timer); clearInterval(expiry); leave();
    store.presence.update({ members: [] });
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    }
  };
}
