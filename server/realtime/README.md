# Workspace realtime

`GET /api/workspaces/:workspaceId/events?afterVersion=N` is an authenticated SSE
stream. The browser sends the same `X-Relay-Account-ID` precondition as synchronization
HTTP; identity comes from the verified session. The route requires membership,
rejects cross-origin requests, and sets private/no-store/no-transform headers.
Service workers never cache API requests.

The selected transport is SSE because mutations already use HTTP and the current
realtime path is server to client. No socket server, managed-provider credential,
new dependency, or schema migration is required.

## Event contract

`lib/realtime-contract.ts` validates all frames. An accepted event is:

```ts
{
  type: "operation.accepted",
  workspaceId,
  serverVersion,
  entityVersion,
  authorId,
  operation: { id, workspaceId, type, entityId, payload, baseVersion, timestamp }
}
```

The operation body is exactly the accepted-operation history contract; snapshots
are never broadcast. `stream.ready` establishes the connection and advertises the
current version. `stream.checkpoint` reports the durable head even when no new
operation arrives, detecting a dropped final message. `stream.catch-up` requires
HTTP recovery when retained history is incomplete. `stream.error` distinguishes
revoked access from a temporary stream failure without exposing server details.

## Commit boundary and deployment

Each subscriber reads a bounded page of accepted operations in its own read-only
database transaction, starting after its confirmed cursor. Ingestion atomically
updates entities, workspace version, and operation log. PostgreSQL MVCC prevents
the reader from observing an uncommitted or rolled-back operation. There is no
network publish inside the mutation transaction, and no publish/commit crash gap:
a committed operation remains discoverable even if its HTTP response is lost.

The route checks the database about once per second per open subscriber (plus
query time). Membership is checked on every page. A stream lease is 25 seconds;
reconnection re-verifies the session, bounding session revocation delay. Streams
stop on request abort, consumer cancel, expiry, permission loss, or slow-consumer
buffer limits. Failed streams reconnect with exponential backoff and jitter,
capped near 30 seconds; a silent connection is aborted after 15 seconds. HTTP
401/403/404 or an access-revoked frame stop automatic reconnects.

Deploy on a host supporting streaming Next.js Node route handlers and at least
the lease duration; the route declares a 60-second maximum. Disable buffering in
any reverse proxy. Browser-to-server HTTP/2 avoids the browser's small HTTP/1
per-origin SSE connection limit. This implementation intentionally pays one
bounded log check per subscriber per second; for larger fan-out, replace the
transport with managed pub/sub while keeping this contract and recovery engine.

## Client ordering and lifecycle

Only the opened workspace subscribes, after its local cache restores. Unmount,
offline mode, storage failure, or account blocking aborts its stream. Demo boards
remain local. Reconnect always requests catch-up, even with an empty local queue.

The sync runner owns both live and catch-up application under the existing
account/workspace Web Lock. One next-version live operation may use the fast path.
Gaps and bursts discard that candidate and read ordered HTTP history; there is no
client reorder buffer. New requests arriving during an active sync cause another
pass and are checked before uploads. A received version never advances the durable
cursor by itself.

Both paths call `store.sync.apply` / `repository.sync.apply`, atomically persisting
the confirmed base, cursor, visible projection, pending queue, and conflicts.
Own operation IDs acknowledge and remove pending work once; versions already
incorporated are no-ops. Compatible remote edits preserve local intent; overlaps
use the existing conflict records and resolution controls.

Focused item fields persist every keystroke in IndexedDB and hold that entity's
uploads until blur. This keeps actively typed intent available to ordinary conflict
detection. Stage rename drafts save against the version captured when editing
began, so a concurrent rename cannot be silently overwritten on blur.

Realtime status and event metadata are ephemeral and distinct from durable sync
metadata. The inspector exposes connection state, received version, latest remote
operation, catch-up required, last event timestamp, and transport errors. Remote
card/stage feedback appears only after successful durable application; duplicate
or own-operation echoes do not restart it.
