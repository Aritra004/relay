import type { WorkspaceStore } from "../components/workspace/workspace-store.ts";
import type { startWorkspaceSync } from "./workspace-sync.ts";
import {
  realtimeEventSchema,
  type RealtimeEvent,
} from "./realtime-contract.ts";
import { consumeWorkspaceEvents, RealtimeError } from "./realtime-http.ts";

export function startWorkspaceRealtime(
  store: WorkspaceStore,
  sync: Pick<ReturnType<typeof startWorkspaceSync>, "receive" | "reconcile">,
  {
    consume = consumeWorkspaceEvents,
    retryDelay = (attempt: number) =>
      Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5)) + Math.random() * 500,
    idleMs = 15_000,
  }: {
    consume?: typeof consumeWorkspaceEvents;
    retryDelay?: (attempt: number) => number;
    idleMs?: number;
  } = {},
) {
  let stopped = false,
    terminal = false,
    attempt = 0;
  let suspended = false;
  let connection: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const eligible = () => {
    const state = store.getSnapshot();
    return (
      !stopped &&
      !suspended &&
      !terminal &&
      state.workspace.source === "server" &&
      state.restoration === "ready" &&
      state.syncStatus !== "offline" &&
      !state.editingBlocked &&
      !state.storageError &&
      state.syncMetadata.confirmedServerVersion != null
    );
  };
  function schedule(delay: number) {
    if (!eligible() || connection || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
  }
  async function connect() {
    if (!eligible() || connection) return;
    const state = store.getSnapshot();
    const controller = new AbortController();
    connection = controller;
    let ready = false;
    let receivedAt = 0;
    const watch = () => {
      clearTimeout(watchdog);
      watchdog = setTimeout(() => controller.abort(), idleMs);
    };
    store.realtime.update({
      status: attempt ? "reconnecting" : "connecting",
      error: null,
    });
    watch();
    try {
      await consume(
        state.workspace.id,
        state.syncMetadata.confirmedServerVersion!,
        state.workspace.cachedForUserId!,
        controller.signal,
        (input: RealtimeEvent) => {
          if (stopped || controller.signal.aborted || !eligible()) return;
          const event = realtimeEventSchema.parse(input);
          if (event.workspaceId !== state.workspace.id)
            throw new RealtimeError("Realtime workspace mismatch.");
          watch();
          receivedAt = Date.now();
          store.realtime.update({
            lastEventAt: new Date(receivedAt).toISOString(),
          });
          if (event.type === "stream.error")
            throw new RealtimeError(
              event.code === "ACCESS_REVOKED"
                ? "Workspace access has changed. Reopen the workspace after signing in."
                : "Realtime stream interrupted.",
              event.code === "ACCESS_REVOKED",
            );
          const confirmed =
            store.getSnapshot().syncMetadata.confirmedServerVersion ?? 0;
          const previous =
            store.getSnapshot().realtime.latestReceivedServerVersion ?? 0;
          store.realtime.update({
            latestReceivedServerVersion: Math.max(
              previous,
              event.serverVersion,
            ),
          });
          if (event.type === "stream.ready") {
            ready = true;
            store.realtime.update({ status: "connected", error: null });
            sync.reconcile();
          } else if (event.type === "operation.accepted") {
            if (!ready) throw new RealtimeError("Realtime handshake missing.");
            const remote = { operation: event.operation, authorId: event.authorId,
              serverVersion: event.serverVersion, entityVersion: event.entityVersion };
            if (
              event.authorId !== state.workspace.cachedForUserId &&
              event.serverVersion > (store.getSnapshot().realtime.latestRemoteOperation?.serverVersion ?? 0)
            )
              store.realtime.update({ latestRemoteOperation: remote });
            sync.receive(remote);
          } else if (
            event.type === "stream.catch-up" ||
            event.serverVersion > confirmed
          ) {
            // Checkpoints detect a dropped final event even if nobody edits again.
            if (!store.getSnapshot().realtime.catchUpRequired) sync.reconcile();
          }
        },
      );
      if (ready && Date.now() - receivedAt < idleMs) attempt = 0;
    } catch (error) {
      if (!stopped && !controller.signal.aborted) {
        terminal = error instanceof RealtimeError && error.terminal;
        store.realtime.update({
          error:
            error instanceof Error
              ? error.message
              : "Realtime connection interrupted.",
        });
        sync.reconcile();
      }
    } finally {
      clearTimeout(watchdog);
      controller.abort();
      if (!stopped) {
        store.realtime.update({
          status: eligible() ? "reconnecting" : "disconnected",
          catchUpRequired: true,
        });
        connection = undefined;
        schedule(retryDelay(attempt++));
      } else connection = undefined;
    }
  }
  const update = () => {
    if (!eligible()) {
      connection?.abort();
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      store.realtime.update({ status: "disconnected" });
      return;
    }
    schedule(0);
  };
  const unsubscribe = store.subscribe(update);
  // Full document navigation does not guarantee React effect cleanup. Explicitly
  // cancel streaming fetches before unload, and resume after a bfcache restore.
  const hide = () => { suspended = true; update(); };
  const show = () => { suspended = false; update(); };
  if (typeof window !== "undefined") {
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
  }
  schedule(0);
  return () => {
    stopped = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    clearTimeout(watchdog);
    connection?.abort();
    store.realtime.update({ status: "disconnected" });
    if (typeof window !== "undefined") {
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    }
  };
}
