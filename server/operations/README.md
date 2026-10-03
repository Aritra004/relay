# Operation synchronization protocol

`lib/operation-contract.ts` is the shared, strict HTTP contract. The local
`Operation` union also retains the earlier demo/cache format; the uploader projects
its create payload onto the HTTP fields. No client author, local revision, or
optimistic entity version is accepted by the API.

`POST /api/workspaces/:workspaceId/operations` accepts one JSON operation:

```json
{
  "id": "af0a416a-89f8-478f-a8bb-29662d061f25",
  "workspaceId": "20ab7968-aec6-499f-b4f0-09119020e281",
  "entityId": "b3353090-6b60-4cfc-bf66-134a476cf62a",
  "type": "UPDATE_ITEM",
  "baseVersion": 3,
  "timestamp": "2026-09-24T10:00:00.000Z",
  "payload": { "title": "Revised title" }
}
```

All IDs are client-generated UUIDs. `timestamp` records client creation time;
queue sequence and server workspace version determine order. The authenticated
session determines the author. `X-Relay-Account-ID`, when supplied, is checked
against that session as a precondition to prevent sending an old account's queue
under a new session. It cannot impersonate an author.

| Type           | Payload                                            | Base version                 |
| -------------- | -------------------------------------------------- | ---------------------------- |
| `CREATE_ITEM`  | `title`, `description`, `stageId`; append to stage | `null`                       |
| `UPDATE_ITEM`  | One or both of `title`, `description`              | Last confirmed item version  |
| `DELETE_ITEM`  | `null`                                             | Last confirmed item version  |
| `MOVE_ITEM`    | `stageId`, `beforeItemId` (`null` appends)         | Last confirmed item version  |
| `RENAME_STAGE` | `name`                                             | Last confirmed stage version |

Unknown keys and types are rejected. New creates and updates require nonblank
titles; descriptions may be empty. The editor retains the last saved valid title
while an empty replacement is being typed. Historical empty-title operations remain
readable for old-cache compatibility, but new ingestion rejects them. Limits are
300 characters for item titles, 20,000 for descriptions, 80 for stage names, and
128 KiB for the complete request. Stage names must be nonblank. Item, stage, and
move-neighbor references must belong to the requested workspace and destination.
Assignee/label defaults in the old local model remain presentation data; there
is no assignee/label mutation API in this phase.

Successful responses use HTTP 200, including retries:

```json
{
  "operationId": "af0a416a-89f8-478f-a8bb-29662d061f25",
  "workspaceId": "20ab7968-aec6-499f-b4f0-09119020e281",
  "entityId": "b3353090-6b60-4cfc-bf66-134a476cf62a",
  "status": "accepted",
  "serverVersion": 12,
  "entityVersion": 4
}
```

Failures return `{ operationId, status: "rejected", error: { kind, code, message,
retryable } }`. The ID is `null` if authentication/body parsing fails before it
can be read. HTTP 400/413/415 are permanent validation errors; 401/403 and the
non-disclosing workspace 404 are authorization errors; 409 is a conflict, including
`FIELD_CONFLICT` with the structured context described below, or invalid reuse of
an ID with different content. Temporary failures use
5xx (or rate limiting 429). SQL and connection details never enter responses.

## Server transaction

`server/operations/service.ts` locks the workspace row, checks and locks current
membership, validates the operation, and takes a transaction-scoped lock on the
operation ID. Under READ COMMITTED, a waiting writer sees the preceding commit.
It checks for a matching accepted operation before checking the current entity,
so a lost-response retry still works after subsequent changes or deletion.
Reusing an ID with a different workspace, author, target, payload, timestamp, type,
or base is rejected. PostgreSQL's operation primary key remains the final guard.

Each new operation checks intervening field/action changes, applies its mutation, increments
the authoritative workspace version in SQL, and inserts its acknowledgment data
in the same transaction. Any failure rolls everything back. Workspace versions
start at 0; created items start at 1; each accepted entity edit advances that
entity by 1. Stages start at 0. Deletes record their final version in the log.
Reordering adjusts integer positions of surrounding cards without advancing
their entity versions; their relative order and content are unchanged.

The existing unique `(workspace_id, server_version)` index both prevents duplicate
versions and supports ordered history reads. `readAcceptedOperations` is the internal bounded query used by the authorized
history endpoint. Deleted item
IDs cannot be recreated in the same workspace with a new operation ID. There is
no foreign key from the log target to its deleted entity.

## Ordered remote history

`GET /api/workspaces/:workspaceId/operations?afterVersion=42&limit=1` returns a
bounded page such as:

```json
{
  "status": "ok",
  "workspaceId": "20ab7968-aec6-499f-b4f0-09119020e281",
  "startingVersion": 42,
  "endingVersion": 43,
  "currentWorkspaceVersion": 47,
  "hasMore": true,
  "operations": [
    {
      "serverVersion": 43,
      "entityVersion": 4,
      "authorId": "6a9e364e-6d2b-40e6-b71f-57b980c6430a",
      "operation": {
        "id": "af0a416a-89f8-478f-a8bb-29662d061f25",
        "workspaceId": "20ab7968-aec6-499f-b4f0-09119020e281",
        "entityId": "b3353090-6b60-4cfc-bf66-134a476cf62a",
        "type": "UPDATE_ITEM",
        "baseVersion": 3,
        "timestamp": "2026-09-24T10:00:00.000Z",
        "payload": { "title": "Revised title" }
      }
    }
  ]
}
```

With the default batch size, a client at version 42 receives versions 43?47 in
one ordered page. Each record contains the complete submitted `operation`,
authenticated `authorId`, `serverVersion`, and resulting `entityVersion`. Creation
appends; moves use their stable destination stage/neighbor; deletes retain their
target and final version. All five operation types replay without a snapshot.

`startingVersion` is the exclusive requested cursor; `endingVersion` is the last
included version (equal to the cursor for an empty page). Default batches contain
at most 100 operations, with a maximum requested limit of 500. Cursors and limits
must be nonnegative safe integers (limits must also be positive). Versions beyond
the current workspace version are rejected. Membership, current version and log
are read in one repeatable-read transaction, and every response is private/no-store.

A missing version returns `{ status: "snapshot-required", workspaceId,
currentWorkspaceVersion, reason: "OPERATION_HISTORY_UNAVAILABLE" }`. The client
also validates workspace identity, ordering, contiguity, bounds and pagination
before applying any page.

`GET .../operations?operationId=<uuid>` is a read-only receipt lookup returning
`{ accepted: <complete remote operation> | null }`, scoped to the authenticated
author and workspace membership. Recovery uses it to recognize an accepted queue
head after a lost response. No pruning job is introduced here. Future retention
must preserve idempotency receipts and creation tombstones; deleting those along
with downloadable history would break retry and deleted-ID guarantees.

## State machine and durable layers

`lib/workspace-sync.ts` owns one explicit phase from `lib/sync-contract.ts`:

```text
idle -> checking -> pulling -> applying-remote -> pushing-local -> pulling
                                      |                            |
                                      +----------> synced <--------+
Any active phase -> offline | conflict | error
Reconnect / deliberate retry -> checking
```

The transition table enforces legal changes. `synced` requires an empty durable
queue, a contiguous confirmed version matching the latest checked server version,
and no unresolved conflict. It describes the last completed check, not a promise
that no collaborator can commit afterward. The [SSE transport](../realtime/README.md)
feeds this same runner when collaborators make changes.

IndexedDB v4 adds `confirmedWorkspaces`, separate from the visible entity tables.
The layers are: confirmed server snapshot, ordered pending local operations, and
the visible projection obtained by replaying those operations on the confirmed
snapshot. Local and remote changes use the same pure `applyOperationData` domain
logic; only local user actions enqueue new operations.

`confirmedServerVersion` is the highest **contiguous** server version fully
incorporated into the confirmed snapshot. Local edits never advance it.
`currentServerVersion` is the latest known server version. The legacy
`lastServerVersion` remains a compatibility upload high-water mark and is never
used as a pull cursor. Pre-v4 optimistic caches cannot prove a confirmed base:
they preserve all data and recover through an authorized snapshot. The known
v3 stage-baseline migration is retained.

## Pull-first synchronization

1. Acquire the account/workspace Web Lock and flush local persistence.
2. Read the confirmed cursor; download bounded, ordered history pages.
3. Classify each remote operation against the durable pending queue.
4. Apply remote changes to confirmed state, record overlaps, replay pending intent, and persist the
   changed visible entities, queue bases, confirmed base, cursor and sync metadata
   in one IndexedDB transaction. An interrupted transaction advances nothing.
5. After catching up, freeze the first independent pending operation's body durably, submit it,
   and wait for acknowledgment. Uploads are sequential.
6. An adjacent acknowledgment is applied through the same remote commit path. A
   version gap retains the submitted operation and cursor until a pull fills every missing
   version, including the accepted operation's echo. Never jump across a gap.
7. Pull again after every acknowledgment, including the final one, until caught up.

Own operation echoes acknowledge the matching pending operation atomically and are never
applied twice. A lost response keeps the exact submitted ID/body; a later pull can
recognize acceptance without a second POST. Only a definitive stale/reference
rejection releases a frozen body for another pull and safe rebase. Edits made
during requests or IndexedDB transactions remain optimistic and durable; an edit
that overlaps a remote commit is retained as a conflict.

The runner starts on online workspace mount, reconnect, focus/visibility/pageshow,
new durable edits, and the inspector's **Sync now / Retry sync** control. An in-flight
guard and Web Lock prevent duplicate runs in a tab or across tabs. Offline/unmount
aborts outstanding requests. Accepted work remains removed after restart; the
remaining queue resumes in order. Stale local tabs must reopen before writing.

## Conflict handling and snapshot recovery

The complete [conflict matrix](CONFLICTS.md) defines all supported pairs and
reference dependencies. The server compares accepted operations after the supplied
entity base: disjoint title/description fields and edit/move pairs merge. It never
uses a version mismatch by itself as evidence of conflicting intent.

A real conflict returns HTTP 409 with `conflict`: the rejected `operation`,
`entityId`, `entityType`, `fields`, `clientValues`, `serverValues`, `serverEntity`
(or null for deletion), `serverEntityVersion`, and `serverWorkspaceVersion`.
`lib/conflict-contract.ts` validates this same structure on the client.

Conflicts and recent resolutions live in IndexedDB workspace sync metadata. Remote
history still advances the confirmed projection and cursor. The optimistic board
retains unresolved local intent, including edits to remotely deleted items. Uploads
skip conflicted entities and dependent moves, preserving order within each entity.

Keep mine replaces rejected intent with new operation IDs and current confirmed
bases. Use server removes only conflicting fields/actions. Compatible fields and
other entities remain queued. Restoring a deleted item creates a new item identity
with the saved local contents. Queue replacement, board changes, and resolution
history commit in one transaction. A later race creates a new conflict; it never
forces a stale resolution through.

Snapshot recovery retains original bases when history is missing so the server can
check fields safely. It does not infer a safe merge from changed versions or rebase
uncertain edits. Server evidence queries are bounded to 1,000 intervening entity
operations; gaps require an explicit decision with both current and local values.

## Retry and inspection

Network interruption, timeouts, 429/408 and server failures use exponential backoff
with jitter, capped at 60 seconds and five attempts. Retry metadata survives reload,
including failures when no local operation is queued. Authorization, malformed
operations and invalid workspaces stop automatic retries. Unresolved conflicts pause only their entities and dependencies.

The inspector shows connection, actual phase, contiguous confirmed/latest server
versions, local/saved revisions, pending and unsaved counts, received/applied remote
operations, upload progress, recent acknowledgments, last completed sync, snapshot
time, errors, attempt count and retry time. The standalone demo stays local.

## Verification

`npm test` exercises IndexedDB atomicity, queue ordering, lost-response recovery,
concurrent local edits, permanent failures and account isolation. Server tests
cover the contract and HTTP errors. `npm run test:server:integration` exercises
real PostgreSQL mutations, authorization, stale references, rollback and concurrent
connections. Database suites run sequentially because they temporarily install
failure triggers inside rolled-back transactions. The concurrency test uses
committed uniquely named fixtures and removes only those rows afterward.

`npm run test:online` exercises the authenticated browser path, delayed/lost
acknowledgments, all five actions, inspector data, reload durability and database
history. Production service-worker offline reload testing requires an explicitly requested build.
`lib/workspace-sync.test.mjs` covers pull ordering, concurrent edits, rollback,
version gaps, reconnect/resume, lost responses, snapshots and retry behavior.
`server/tests/history.integration.ts` verifies authorized bounded history and
reconstruction against actual PostgreSQL state.
