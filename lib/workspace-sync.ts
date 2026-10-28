import type { WorkspaceStore } from "../components/workspace/workspace-store.ts";
import type { Operation } from "../components/workspace/workspace-operations.ts";
import { accountRegistry } from "./local-account.ts";
import {
  OperationUploadError,
  submitOperation,
  submittedOperation,
  validateAcknowledgment,
} from "./operation-upload-http.ts";
import {
  fetchOperationHistory,
  fetchSyncSnapshot,
  fetchOperationReceipt,
  validateHistory,
} from "./sync-http.ts";
import { sameOperation } from "./sync-replay.ts";
import { nextUpload, unresolvedConflicts } from "./conflict-contract.ts";
import type { RemoteOperation } from "./sync-contract.ts";

export interface SyncOptions {
  submit?: typeof submitOperation;
  pull?: typeof fetchOperationHistory;
  snapshot?: typeof fetchSyncSnapshot;
  receipt?: typeof fetchOperationReceipt;
  verifyAccount?: (userId: string) => Promise<boolean>;
  lock?: (name: string, run: () => Promise<void>) => Promise<void>;
  now?: () => number;
  retryDelay?: (attempt: number) => number;
}

// One runner owns the phase. Every request stays under the same cross-tab lock.
export function startWorkspaceSync(
  store: WorkspaceStore,
  {
    submit = submitOperation,
    pull = fetchOperationHistory,
    snapshot = fetchSyncSnapshot,
    receipt = fetchOperationReceipt,
    verifyAccount = async (userId) => {
      const account = await accountRegistry.read();
      return account?.status === "active" && account.user?.id === userId;
    },
    lock = async (name, run) => {
      if (!navigator.locks)
        throw new OperationUploadError(
          "validation",
          "SYNC_LOCK_UNAVAILABLE",
          "This browser cannot coordinate workspace synchronization safely.",
        );
      await navigator.locks.request(
        name,
        { ifAvailable: true },
        async (held) => {
          if (held) await run();
        },
      );
    },
    now = Date.now,
    retryDelay = (attempt) =>
      Math.min(60_000, 1000 * 2 ** (attempt - 1)) +
      Math.floor(Math.random() * 500),
  }: SyncOptions = {},
) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let request: AbortController | undefined;
  // One adjacent event is enough for a fast path. Bursts/gaps use ordered HTTP
  // history instead of maintaining an unbounded client-side reorder buffer.
  let liveOperation: RemoteOperation | undefined;
  let pullRequired = true;
  function caughtUp(requested: number) {
    const state = store.getSnapshot();
    if (
      state.syncRequest === requested &&
      state.syncMetadata.confirmedServerVersion != null &&
      state.syncMetadata.confirmedServerVersion >=
        (state.realtime.latestReceivedServerVersion ?? 0)
    )
      store.realtime.update({ catchUpRequired: false });
  }
  const eligible = () => {
    const s = store.getSnapshot();
    return (
      !stopped &&
      s.workspace.source === "server" &&
      s.restoration === "ready" &&
      s.syncStatus !== "offline" &&
      !s.editingBlocked &&
      !s.storageError
    );
  };
  function schedule(delay = 0) {
    if (!eligible() || running || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void run();
    }, delay);
  }
  async function run() {
    if (!eligible() || running) return;
    running = true;
    const requested = store.getSnapshot().syncRequest;
    let nextDelay: number | undefined;
    let operation: Operation | undefined;
    try {
      const initial = store.getSnapshot();
      const accountId = initial.workspace.cachedForUserId!,
        workspaceId = initial.workspace.id;
      let acquired = false;
      await lock(`relay-sync:${accountId}:${workspaceId}`, async () => {
        acquired = true;
        const saved = await store.upload.prepare();
        if (!saved || !eligible()) return;
        const failure = saved.syncMetadata?.uploadFailure;
        if (failure) {
          store.sync.phase("error");
          if (failure.kind !== "temporary" || !failure.retryAt) return;
          const delay = Date.parse(failure.retryAt) - now();
          if (delay > 0) {
            nextDelay = delay;
            return;
          }
        }
        store.sync.phase("checking");
        request = new AbortController();
        const signal = request.signal;
        async function verify() {
          if (!eligible() || signal.aborted)
            throw new DOMException("Sync interrupted", "AbortError");
          if (!(await verifyAccount(accountId)))
            throw new OperationUploadError(
              "authorization",
              "ACCOUNT_CHANGED",
              "Sign in to the account that owns this local workspace.",
            );
        }
        async function recover() {
          await verify();
          const current = await store.upload.prepare();
          const head =
            current?.syncMetadata?.submittedOperation ??
            current?.pendingOperations[0];
          // Read-only lookup handles a lost response before snapshot recovery.
          if (head) {
            const accepted = await receipt(
              workspaceId,
              head.id,
              accountId,
              signal,
            );
            await verify();
            if (accepted) {
              if ("archived" in accepted) {
                // The compact receipt omits payloads. Resubmit the identical
                // frozen body to verify its hash before acknowledging locally.
                const ack = validateAcknowledgment(await submit(head, accountId, signal), head);
                await verify();
                if (ack.serverVersion !== accepted.archived.serverVersion)
                  throw new OperationUploadError("temporary", "INVALID_RECEIPT", "The archived receipt could not be verified.");
                await store.sync.receipt(head, ack);
              } else {
              if (!sameOperation(head, accepted, accountId))
                throw new OperationUploadError(
                  "conflict",
                  "OPERATION_ID_REUSED",
                  "The recovery receipt differs from local work.",
                );
              await store.sync.receipt(head, {
                operationId: head.id,
                workspaceId,
                entityId: head.entityId,
                status: "accepted",
                serverVersion: accepted.serverVersion,
                entityVersion: accepted.entityVersion,
              });
              }
            }
          }
          const fresh = await snapshot(workspaceId, accountId, signal);
          await verify();
          store.sync.phase("applying-remote");
          await store.sync.snapshot(fresh);
        }
        let staleResponses = 0;
        while (eligible() && !signal.aborted) {
          await verify();
          let current = await store.upload.prepare();
          if (!current) return;
          const cursor = current.syncMetadata?.confirmedServerVersion;
          if (
            cursor === undefined ||
            cursor === null ||
            (current.syncMetadata?.syncConflict &&
              !unresolvedConflicts(current.syncMetadata).length)
          ) {
            await recover();
            continue;
          }
          const live = liveOperation;
          liveOperation = undefined;
          if (!pullRequired && live && live.serverVersion === cursor + 1) {
            await verify();
            store.sync.phase("applying-remote");
            await store.sync.apply(live, live.serverVersion);
            continue;
          }
          pullRequired = false;
          store.sync.phase("pulling");
          const page = validateHistory(
            await pull(workspaceId, cursor, accountId, signal),
            workspaceId,
            cursor,
          );
          await verify();
          if (page.status === "snapshot-required") {
            await recover();
            continue;
          }
          await store.sync.checked(page.currentWorkspaceVersion);
          for (const remote of page.operations) {
            await verify();
            store.sync.phase("applying-remote");
            await store.sync.apply(remote, page.currentWorkspaceVersion);
          }
          if (page.hasMore) continue;
          if (liveOperation || pullRequired) continue;
          current = await store.upload.prepare();
          if (!current) return;
          operation =
            current.syncMetadata?.submittedOperation ??
            nextUpload(
              current.pendingOperations,
              current.syncMetadata?.conflicts ?? [],
            );
          if (!operation) {
            await store.sync.checked(page.currentWorkspaceVersion, true);
            if (
              nextUpload(
                store.getSnapshot().pendingOperations,
                store.getSnapshot().syncMetadata.conflicts ?? [],
              )
            )
              continue;
            store.sync.phase(
              unresolvedConflicts(store.getSnapshot().syncMetadata).length
                ? "conflict"
                : "synced",
            );
            caughtUp(requested);
            return;
          }
          // Text remains durable and optimistic while focused. Holding its
          // upload leaves concurrent edits visible to the normal conflict path.
          if (operation.entityId === store.getSnapshot().editingEntityId) {
            store.sync.phase(
              unresolvedConflicts(store.getSnapshot().syncMetadata).length
                ? "conflict"
                : "idle",
            );
            caughtUp(requested);
            return;
          }
          await verify();
          operation = await store.sync.markSubmitted(operation);
          submittedOperation(operation);
          store.sync.phase("pushing-local");
          store.upload.setActive(operation.id);
          try {
            const ack = validateAcknowledgment(
              await submit(operation, accountId, signal),
              operation,
            );
            await verify();
            await store.sync.receipt(operation, ack);
            // An adjacent acknowledgment cannot hide intervening remote changes.
            // A gap leaves the queue/cursor intact until the next ordered pull.
            const confirmed =
              store.getSnapshot().syncMetadata.confirmedServerVersion!;
            if (ack.serverVersion === confirmed + 1) {
              store.sync.phase("pulling");
              store.sync.phase("applying-remote");
              await store.sync.apply(
                {
                  operation: submittedOperation(operation),
                  authorId: accountId,
                  serverVersion: ack.serverVersion,
                  entityVersion: ack.entityVersion,
                },
                ack.serverVersion,
              );
            }
            staleResponses = 0;
          } catch (error) {
            if (error instanceof OperationUploadError && error.conflict) {
              await store.sync.reject(error.conflict);
              continue;
            }
            if (
              error instanceof OperationUploadError &&
              [
                "STALE_VERSION",
                "INVALID_NEIGHBOR",
              ].includes(error.code)
            ) {
              // Only definitive rejection releases the frozen idempotent body.
              await store.sync.releaseSubmission();
              if (++staleResponses < 3) continue;
              throw new OperationUploadError(
                "temporary",
                "WORKSPACE_BUSY",
                "The workspace keeps changing. Sync will retry shortly.",
              );
            }
            throw error;
          } finally {
            store.upload.setActive(null);
          }
        }
      });
      if (!acquired) nextDelay = 1000;
    } catch (error) {
      if (!stopped && !request?.signal.aborted) {
        if (
          error instanceof Error &&
          [
            "QuotaExceededError",
            "StaleWorkspaceError",
            "InvalidLocalDataError",
            "DatabaseClosedError",
          ].includes(error.name)
        ) {
          store.upload.storageFailure(error);
          store.sync.phase("error");
        } else {
          const failure =
            error instanceof OperationUploadError
              ? error
              : new OperationUploadError(
                  "temporary",
                  "REQUEST_FAILED",
                  "Sync was interrupted. Saved changes will be retried.",
                );
          const previous = store.getSnapshot().syncMetadata.uploadFailure;
          const attempts = Math.min(5, (previous?.attempts ?? 0) + 1);
          const delay = retryDelay(attempts);
          const retryAt =
            failure.kind === "temporary" && attempts < 5
              ? new Date(now() + delay).toISOString()
              : null;
          await store.upload
            .fail({
              operationId: operation?.id ?? "sync",
              kind: failure.kind,
              code: failure.code,
              message: failure.message,
              attempts,
              retryAt,
            })
            .catch(store.upload.storageFailure);
          store.sync.phase(failure.kind === "conflict" ? "conflict" : "error");
          if (retryAt) nextDelay = delay;
        }
      }
    } finally {
      request = undefined;
      running = false;
      store.upload.setActive(null);
      if (nextDelay !== undefined) schedule(nextDelay);
      else if (
        eligible() &&
        !store.getSnapshot().syncMetadata.uploadFailure &&
        (store.getSnapshot().syncRequest !== requested ||
          (nextUpload(
            store.getSnapshot().pendingOperations,
            store.getSnapshot().syncMetadata.conflicts ?? [],
          ) &&
            nextUpload(
              store.getSnapshot().pendingOperations,
              store.getSnapshot().syncMetadata.conflicts ?? [],
            )?.entityId !== store.getSnapshot().editingEntityId))
      )
        schedule();
    }
  }
  const trigger = () => {
    const s = store.getSnapshot();
    return JSON.stringify([
      s.restoration,
      s.syncStatus,
      s.persistedLocalRevision,
      s.syncRequest,
      s.editingBlocked,
      s.storageError,
    ]);
  };
  let previousTrigger = trigger();
  const unsubscribe = store.subscribe(() => {
    if (!eligible()) request?.abort();
    const next = trigger();
    if (next === previousTrigger) return;
    previousTrigger = next;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    schedule();
  });
  const active = () => {
    if (
      typeof document === "undefined" ||
      document.visibilityState === "visible"
    )
      store.sync.request();
  };
  if (typeof window !== "undefined" && typeof document !== "undefined") {
    window.addEventListener("focus", active);
    window.addEventListener("pageshow", active);
    document.addEventListener("visibilitychange", active);
  }
  schedule();
  const stop = () => {
    stopped = true;
    unsubscribe();
    if (timer !== undefined) clearTimeout(timer);
    request?.abort();
    if (
      ["checking", "pulling", "applying-remote", "pushing-local"].includes(
        store.getSnapshot().syncPhase,
      )
    )
      store.sync.phase(
        store.getSnapshot().syncStatus === "offline" ? "offline" : "idle",
      );
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      window.removeEventListener("focus", active);
      window.removeEventListener("pageshow", active);
      document.removeEventListener("visibilitychange", active);
    }
  };
  return Object.assign(stop, {
    receive(remote: RemoteOperation) {
      if (
        stopped ||
        remote.operation.workspaceId !== store.getSnapshot().workspace.id
      )
        return;
      const cursor = store.getSnapshot().syncMetadata.confirmedServerVersion;
      if (cursor != null && remote.serverVersion <= cursor) return;
      if (
        cursor == null ||
        remote.serverVersion !== cursor + 1 ||
        (liveOperation && liveOperation.operation.id !== remote.operation.id)
      ) {
        liveOperation = undefined;
        pullRequired = true;
        store.realtime.update({ catchUpRequired: true });
      } else if (!pullRequired) liveOperation = remote;
      store.sync.request();
    },
    reconcile() {
      if (stopped) return;
      liveOperation = undefined;
      pullRequired = true;
      store.realtime.update({ catchUpRequired: true });
      store.sync.request();
    },
  });
}
