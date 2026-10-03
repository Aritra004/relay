import "server-only";
import { setTimeout as delay } from "node:timers/promises";
import { acceptedEvent, type RealtimeEvent } from "../../lib/realtime-contract";
import type { OperationHistory } from "../../lib/sync-contract";
import { ApiError } from "../http/errors";

// Tail the durable log through separate read-only transactions. There is no
// pre-commit publisher or process-local room registry: every instance observes
// only committed operations, including commits whose POST response was lost.
export function operationStream({
  initial,
  read,
  signal,
  pollMs = 1000,
  lifetimeMs = 25_000,
}: {
  initial: OperationHistory;
  read: (cursor: number) => Promise<OperationHistory>;
  signal: AbortSignal;
  pollMs?: number;
  lifetimeMs?: number;
}) {
  const lifetime = new AbortController();
  const abort = () => lifetime.abort();
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const expires = setTimeout(abort, lifetimeMs);
      const send = (event: RealtimeEvent) => {
        if (lifetime.signal.aborted) return;
        // Bound slow-consumer buffering; reconnect recovers from the durable cursor.
        if ((controller.desiredSize ?? 0) < -100) {
          abort();
          return;
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
        );
      };
      try {
        send({
          type: "stream.ready",
          workspaceId: initial.workspaceId,
          serverVersion: initial.currentWorkspaceVersion,
        });
        let page = initial;
        while (!lifetime.signal.aborted) {
          if (page.status === "snapshot-required") {
            send({
              type: "stream.catch-up",
              workspaceId: page.workspaceId,
              serverVersion: page.currentWorkspaceVersion,
            });
            break;
          }
          for (const remote of page.operations) send(acceptedEvent(remote));
          send({
            type: "stream.checkpoint",
            workspaceId: page.workspaceId,
            serverVersion: page.currentWorkspaceVersion,
          });
          if (!page.hasMore)
            await delay(pollMs, undefined, { signal: lifetime.signal });
          if (!lifetime.signal.aborted) page = await read(page.endingVersion);
        }
      } catch (error) {
        if (!lifetime.signal.aborted) {
          send({
            type: "stream.error",
            workspaceId: initial.workspaceId,
            code:
              error instanceof ApiError &&
              [401, 403, 404].includes(error.status)
                ? "ACCESS_REVOKED"
                : "STREAM_UNAVAILABLE",
          });
        }
      } finally {
        clearTimeout(expires);
        signal.removeEventListener("abort", abort);
        // A consumer cancel already closes its controller.
        if (!cancelled) controller.close();
      }
    },
    cancel() {
      cancelled = true;
      lifetime.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "private, no-store, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
