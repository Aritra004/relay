# Relay

Relay is an offline-first collaborative workspace for teams that need to keep working even when the network is unreliable.

## Current implementation

Relay uses Next.js, React, Neon PostgreSQL/Drizzle, Managed Better Auth, and Dexie.
The sections describing earlier phases below are implementation history; the current
system includes pull-first synchronization, durable conflicts, realtime SSE,
ephemeral presence, and operation-log retention.

```sh
npm install
# Copy .env.example to .env.local and supply a development Neon branch's values.
npm run db:migrate
npm run db:check
npm run dev
```

Open `/account` to sign in and create a shared workspace. `/` is an independent
local workspace; production starts empty, while development seeds example cards.
Existing cached work is never replaced by a new seed. Shared workspace membership
is checked by every private API; member-management UI is not implemented yet.
The two-user browser test provisions and removes its own membership fixtures.

The [server setup](server/README.md), [sync protocol](server/operations/README.md),
[conflict rules](server/operations/CONFLICTS.md), and [hardening runbook](HARDENING.md)
describe the implemented behavior, verification commands, and release checks.

Users can create a workspace, organize work across stages, collaborate with other people in real time, continue editing while offline, and safely synchronize pending changes when connectivity returns.

The core engineering challenge is not the board UI. It is distributed state:

- optimistic updates
- local persistence
- offline mutation queues
- synchronization
- conflict handling
- real-time collaboration
- reconnection
- presence
- durable server state

## Product Idea

Most collaborative tools assume the network is available.

Relay assumes it may disappear.

A user should be able to:

1. Open a workspace.
2. Create and edit items.
3. Lose internet access.
4. Continue working normally.
5. Refresh while offline and keep their local state.
6. Reconnect later.
7. Synchronize pending changes without losing work.
8. See changes made by collaborators while they were away.

The product should make this invisible synchronization understandable rather than hiding it completely.

## Example

Two people are editing the same workspace.

User A changes:

`Design landing page -> Completed`

At roughly the same time, User B changes:

`Design landing page -> In Review`

Relay must decide how those operations synchronize.

Now User A goes offline and continues editing:

- creates two items
- renames a stage
- moves an item
- edits a description

The UI should continue to work immediately.

Relay shows:

`Offline · 4 changes pending`

When the connection returns:

`Syncing 4 changes...`

and finally:

`Synced`

No refresh. No lost edits.

## Core Product Principles

Relay should be:

- local-first in feel
- optimistic by default
- resilient to temporary network loss
- explicit about sync state
- predictable during conflicts
- fast even on unreliable connections
- understandable to users when something cannot be merged automatically

## Core Features

### Workspaces

Users can create collaborative workspaces and invite other people.

### Workflow Lanes

Items move through a compact workflow such as:

`IDEA -> PLANNED -> BUILDING -> REVIEW -> SHIPPED`

The visual model should not become a generic Trello clone.

### Optimistic Editing

Creating, renaming, moving, and editing items should update the interface immediately.

The server confirms the operation afterward.

### Offline Persistence

Workspace state should be persisted locally using IndexedDB.

Refreshing the browser while offline should not destroy local work.

### Pending Operation Queue

Mutations created while offline are stored locally.

When connectivity returns, Relay synchronizes them with the server.

### Reconnection

Relay should recover from temporary connection failures automatically.

### Conflict Handling

The system should define explicit behavior for concurrent edits.

Conflicts should never be silently resolved in a way that loses meaningful user work.

The [complete conflict matrix](server/operations/CONFLICTS.md) specifies every
supported operation pair. Disjoint edits merge automatically. Same-field edits,
competing moves, and deletion versus edit require a decision.

Cards show a **Conflict** badge. Open a marked card or the **Sync Inspector** to
compare your version with the server's. **Keep mine** creates a new operation at
the latest confirmed version. **Use server version** preserves compatible local
fields. For a remote deletion, choose **Keep deleted** or **Restore item with local
edits** (restoration creates a new item identity).

Unresolved conflicts survive refresh and browser restart in IndexedDB. Unrelated
items keep syncing. The inspector retains the latest 20 resolved conflicts, and a
resolution that races another edit can conflict again without overwriting it.

### Realtime Collaboration

Changes made by another connected user should appear without a manual refresh.

### Presence

Shared workspaces show live collaborator initials, names, and an online count.
Presence uses separate, expiring PostgreSQL UNLOGGED leases and in-memory client
state. It never changes workspace versions or enters IndexedDB. Heartbeats run
every 10 seconds while realtime is connected; a lease expires after 45 seconds.
Active editing is throttled, expires after inactivity, and clears on editor close.

### Sync Inspector

The connection indicator opens a technical-but-readable Sync Inspector.

Example:

Local version: `191`\
Server version: `184`\
Pending operations: `7`

When synchronization finishes:

Local version: `192`\
Server version: `192`\
Pending operations: `0`

This is a signature product feature because it makes the distributed-state architecture visible.

## Recommended Tech Stack

### Application

- Next.js
- React
- TypeScript
- Tailwind CSS

### Server State

- PostgreSQL
- Neon
- Drizzle ORM

### Local State

- IndexedDB
- a thin local persistence layer, optionally using Dexie if it materially simplifies IndexedDB access

### Authentication

Use a mature authentication provider rather than building authentication from scratch.

### Realtime

Online workspaces use server-sent events (SSE) through an authenticated Next.js
route. Operations still upload over HTTP. Each workspace subscription tails the
committed PostgreSQL operation log and sends small `operation.accepted` events.
No provider account, API key, additional dependency, or database migration is needed.

SSE suits the current server-to-client traffic; [MDN documents the transport](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events/Using_server-sent_events),
and [Next.js route handlers support streaming responses](https://nextjs.org/docs/app/api-reference/file-conventions/route).
PostgreSQL remains durable server state. The [realtime protocol](server/realtime/README.md)
describes recovery, authorization, lifecycle, and deployment limits.

## High-Level Architecture

### Online Editing

User action\
-> optimistic local update\
-> local operation created\
-> operation sent to server\
-> server validates and persists\
-> server acknowledges\
-> local pending operation removed

### Offline Editing

User action\
-> optimistic local update\
-> operation persisted in IndexedDB\
-> pending queue grows\
-> network returns\
-> queued operations synchronize\
-> server state and local state converge

### Collaborative Updates

User A changes workspace\
-> server persists operation\
-> realtime transport notifies User B\
-> User B applies remote operation\
-> local UI updates

## Initial Domain Model

### Workspace

Represents a collaborative space.

Suggested fields:

- id
- name
- createdBy
- createdAt
- updatedAt

### WorkspaceMember

Represents user access to a workspace.

Suggested fields:

- workspaceId
- userId
- role
- joinedAt

### WorkflowStage

Represents a stage in the workflow.

Suggested fields:

- id
- workspaceId
- name
- position
- createdAt
- updatedAt

### WorkItem

Represents a collaborative item.

Suggested fields:

- id
- workspaceId
- stageId
- title
- description
- position
- version
- createdBy
- createdAt
- updatedAt

The current `WorkItem` type requires a readonly numeric `version`. Mock items
and newly created local items start at `1`. Local edits and moves preserve the
existing value until a server acknowledgment advances it. Entity counters are
separate from the local revision and authoritative server workspace version.

### Operation

Represents one meaningful user mutation that can be uploaded from a server workspace.
`components/workspace/workspace-operations.ts` defines `Operation` as a readonly
discriminated union: its `type` determines the allowed payload.

Every operation contains:

- `id`: a client-generated operation UUID, distinct from the item's ID.
- `workspaceId`: the workspace containing the target.
- `entityId`: the permanent item ID, or the stage ID for a rename.
- `type`: one of the five supported operation types below.
- `payload`: the data describing that specific change.
- `baseVersion`: the last confirmed item/stage version, or `null` for creation.
  Successors on the same entity advance after acknowledgment of our own prior edit.
- `timestamp`: client creation time as a UTC ISO 8601 string. It does not define
  authoritative ordering or conflict resolution.

| Operation type | Payload | Base version |
| --- | --- | --- |
| `CREATE_ITEM` | Initial `title`, `description`, `stageId`, `assignee`, `label`, and `version` (currently `1`); appends to the stage | `null`, because the item is new |
| `UPDATE_ITEM` | At least one of `title` or `description`; an empty string clears text | Existing item version |
| `DELETE_ITEM` | `null`; `entityId` identifies the item | Existing item version |
| `MOVE_ITEM` | Destination `stageId` and `beforeItemId` (`null` means append) | Existing item version |
| `RENAME_STAGE` | New `name`; `entityId` identifies the stage | Confirmed stage version; legacy/demo renames retain `null` |

Moves represent both within-stage ordering and cross-stage movement. Keyboard
directions and active filters must be resolved to a destination and neighbor ID
before forming an operation. Creation carries the initial domain data, while
presentation fields such as `updated: "Just now"` and `changed` stay out of the
payload. Selection and connectivity changes are not operations.

For example, a standalone move can be represented as:

```ts
import type { Operation } from "./components/workspace/workspace-operations";

const operation = {
  id: crypto.randomUUID(),
  workspaceId: "product-workspace",
  entityId: "RLY-014",
  type: "MOVE_ITEM",
  payload: { stageId: "building", beforeItemId: null },
  baseVersion: 1,
  timestamp: new Date().toISOString(),
} satisfies Operation;
```

Every successful board action now follows `click → create operation → apply
operation → publish local state`. The store creates the operation ID, workspace
and entity IDs, timestamp, payload, and base version before calling
`applyWorkspaceOperation` in `components/workspace/apply-workspace-operation.ts`.
That pure function is the single entry point for applying domain changes and
uses the existing movement helper for ordering. Reapplying a serialized operation
to the same starting snapshot produces the same result without generating IDs
or consulting the clock.

The updated entities, ordering, selection cleanup, `pendingOperations` list, and
`lastOperation` publish together. Every successfully applied operation appends to
the readonly pending list in action order; `lastOperation` also exposes the latest
applied operation. The pending count is always `pendingOperations.length`, with
no separate counter to drift out of sync. No-op or invalid changes leave the
snapshot and list untouched. Selection and connectivity changes do not create
operations.

Operations apply locally and synchronously, then persist with the change in
IndexedDB. Server workspaces upload the durable queue in order. The shared HTTP
contract in `lib/operation-contract.ts` excludes local create defaults (`assignee`,
`label`, `version`); the server assigns authoritative versions and derives the
author from the verified session. See the [upload protocol](server/operations/README.md).

## Development Roadmap

### Phase 1 — Product Shell

Build the workspace UI with mock data.

Focus on:

- navigation
- workflow lanes
- work items
- item editor
- sync status
- visual design

#### Responsive workspace

All five workflow stages stay in one horizontal board. Wide desktop windows
show all five columns; narrower windows scroll the board without compressing
cards. On mobile, swipe across the board or use **Jump to stage**. Each stage
scrolls its items vertically, and short screens can also scroll the page.
Keyboard navigation and the stage selector reveal their destination by scrolling.

#### Previewing sync status during development

Run `npm run dev` and click the connection indicator in the top-right to open
the compact Sync Inspector. Both read the central store's connection state and
pending operations list. While the browser is online, the indicator shows
**Saved locally** for an empty queue and **N changes pending** otherwise. Creating,
updating, moving, and deleting one item adds four operations and automatically
displays **4 changes pending**. **Offline** appears only when the browser reports
it is offline, with the pending count included when nonzero. Reconnecting keeps
the queue and restores the pending label.

The sync service is not connected. Saving locally never implies server acknowledgement.
The inspector shows the complete pending queue, latest first, with readable
descriptions such as **Created item**, **Updated item title**, **Moved item to
REVIEW**, and **Renamed stage**. Each applied edit appears immediately; selection,
filters, and no-op edits do not add operations. Operation payloads are not displayed
as JSON.

**Local revision** starts at `0` and advances once per applied local operation.
**Saved local revision** advances only after its IndexedDB transaction commits.
**Last confirmed server version** tracks the contiguous server state incorporated
by Phase 6 synchronization; it stays unset for the standalone demo. All three values and the pending count come from the store; the durable
revision, server metadata, and pending queue survive reloads.

Expand **Development tools** to inspect sample indicators for Synced,
Offline, Pending, Syncing, and Sync failed. These development-only fixtures
affect only the sample indicator, leaving the actual indicator, inspector,
and workspace state intact.

#### Development tools: local reset and operation queue

Run `npm run dev`, open **Sync Inspector > Development tools**.

- **Operation queue** shows the live queue in creation order, with saved/unsaved
  counts. Expand an entry to inspect its ID, workspace/entity IDs, type, payload,
  base version, and creation timestamp as JSON. Inspection never replays or
  modifies operations.
- **Reset local database** opens an explicit confirmation. **Clear database and
  reseed** removes every local Relay workspace, item, stage, pending operation,
  and sync record on this origin, including unsaved edits, then restores the mock
  workspace with five stages and an empty queue. This is separate from domain
  deletion and does not contact the server or enqueue a reset operation.

The reset pauses edits, settles the active write, and clears/reseeds all local
IndexedDB tables in one transaction. The board and its filters, selection, input
and panel state reset only after success. If reseeding fails, the transaction
rolls back and the existing data and unsaved operations remain available. Each
successful reset changes a local generation token so older tabs cannot write
pre-reset data back into the new workspace; reload those tabs before editing.

The reset works offline in an already-loaded development page. The same controls
remain available on a restoration error screen, allowing explicit recovery from
invalid records. The UI and repository/store reset capabilities are available
only in development. Production startup and storage recovery never clear a queue.
Service-worker offline refresh is still tested against the production build;
Next.js development mode itself does not cache an offline application shell.

Run `npm run test:devtools` for the development browser tests (port 3101, no build
required). They cover queue inspection, cancellation, repeated offline resets,
refresh durability, and recovery from invalid local data. The isolated persistence
tests in `npm test` also cover reset rollback, in-flight writes, stale tabs, and
production guards. These tests use separate databases and browser contexts.

#### Central workspace store

`components/workspace/workspace-store.ts` owns workspace metadata, stages and
items keyed by ID, explicit stage order and item order within each stage,
selected item ID, sync status, pending operations, and the last applied
operation. `WorkspaceActions`
defines exactly five domain actions on `store.actions`:

- `createItem(title, stageId)` creates an item at the end of a stage.
- `updateItem(itemId, changes)` edits only the title and description.
- `deleteItem(itemId)` removes the item and its order entry, clearing selection
  if the deleted item was open.
- `moveItem(move)` changes membership or position using a stage and neighbor ID,
  or a keyboard direction with optional filters resolved against the latest state.
- `renameStage(stageId, name)` changes a stage's display name.

Every domain change goes through these actions and the store's private
`commitOperation` function. Actions describe changes as operations; the local
operation applier updates state. Item records, ordering, selection cleanup,
the last operation, and the pending list commit together in one notification;
no-op actions do not append operations.
Workspace renaming and stage reordering are not supported actions.

Snapshots and their nested entities/arrays are readonly in TypeScript and frozen
at runtime, including entities returned by actions and selectors. There is no
public state setter. `store.selectItem` and `store.setOnline` are separate UI and
browser-status controls; they cannot edit domain data or add pending operations.

`WorkspaceData` defines the normalized shape: `stages` and `items` are ID-keyed
entity maps, `stageOrder` is an array of stage IDs, and `itemOrderByStage` holds
item IDs for each stage. Stage records contain no nested cards. Movement looks
up the item directly and copies only the source/destination ID lists and the
moved item record (including local-edit metadata). Stage records, stage order,
unrelated items, and unaffected order lists retain their references. Reordering
within one stage changes only that stage's list. No full-board flattening or
regrouping is used to commit a move.

`WorkspaceProvider` creates one store in the root layout. React consumers use
`useWorkspaceSelector` and store actions, so re-rendering or remounting a board,
column, card, or editor cannot reseed domain state. Server requests each get
their own instance. Filters, panel visibility, drag previews, focus, and
unfinished form drafts remain ephemeral component state.

The board renders `selectBoard(snapshot, filters)`, which derives every lane,
stage name, card, position, and count from the stored entities and ID orders.
It also works against a serialized snapshot without component history. Filters
only change what is shown. Keyboard movement resolves neighbors against the
latest store state, including the current stage order and visible items.
Creation, editing, deletion, and drag/drop call store actions directly; UI callbacks only reveal
the committed result, restore focus, or announce it. Stage-name and new-item
inputs keep explicitly named drafts until an action commits them.

The store restores IndexedDB before the board mounts. Each supported action
publishes an optimistic change and queues its persistence immediately. Earlier
changes to deleted items remain in the durable operation queue. Reconnecting
never clears or acknowledges operations.

Run `npm test`, `npx tsc --noEmit`, and `npm run lint` to check ordering,
atomic updates, consumer resubscription, stale callbacks, no-op handling,
sync-count consistency, store isolation, and replay of all five action types
from their generated operations.

#### Stable item IDs

`createItem` generates a UUID with `crypto.randomUUID()` before its local commit.
Each new item has its permanent ID immediately, including offline, so it can be
selected, edited, moved, and deleted without a server response. Independent
clients do not share a counter or need to coordinate ID allocation.

Item IDs are opaque and readonly. Edits, moves, serialization, and loading saved
items into a new store preserve the original ID. Future persistence and sync
must store and accept that same ID rather than replace it with a server-generated
one. The existing `RLY-###` IDs remain valid for demo fixtures.

Refresh persistence preserves these identities in IndexedDB. The store and
browser tests cover serialization, restoration, and continued offline editing.
Server workspaces synchronize through the Phase 6 engine. UUID generation uses the platform API in secure
browser contexts (HTTPS or localhost), with no added dependency.

#### Optimistic actions

All five actions commit locally and notify React subscribers synchronously,
before returning to their caller. Their return values indicate whether the local
change was applied; they do not indicate server confirmation. The UI reads this
local snapshot immediately, with no request, spinner, debounce, or connectivity
check between the action and the update. Existing pending edits do not block the
next action while local storage is healthy; a persistence error pauses editing
until saving succeeds.

Moving a card from **PLANNED** to **BUILDING** updates its stage, both lanes,
the open editor, and the pending count together. Creation, field edits, deletion,
and stage renaming use the same local commit path. These behaviors also work
offline. Reconnecting preserves both the edited state and its pending count.

`workspace-optimistic.test.mjs` verifies each action's return value and subscriber
notifications before any asynchronous work can complete, online and offline with
an earlier unconfirmed edit. A future sync service must confirm these local
changes separately; no acknowledgement or rollback is simulated today.

### Phase 2 — Local-First State

#### Startup and storage

`lib/local-db.ts` defines the Dexie database **relay**, at schema version **4**.
`WorkspaceProvider` calls `store.persistence.initialize()` on mount and displays
"Restoring your workspace" until it finishes. Store actions also reject edits
before restoration, so keyboard shortcuts and stale callbacks cannot enqueue
operations against an uninitialized workspace.

`restoreOrSeed()` checks and seeds inside one write transaction. Only a genuinely
missing workspace receives the mock items and five default stages. Existing
workspaces, including empty boards, are loaded as stored. Leftover records without
a workspace are treated as invalid data rather than first use. Pending operations
are already applied to the saved entities: restoration never replays them.

| Table | Primary key | Stored data |
| --- | --- | --- |
| `workspaces` | `id` | Workspace details, stage order, and item order by stage |
| `workflowStages` | `[workspaceId+id]` | Stage and workspace ownership |
| `workItems` | `[workspaceId+id]` | Item and workspace ownership |
| `pendingOperations` | `id` | Original operation and workspace-local enqueue sequence |
| `confirmedWorkspaces` | `id` | Confirmed server base, without pending local operations |
| `workspaceSyncMetadata` | `workspaceId` | Local revision, last confirmed server version, last successful sync time |

The v1-to-v2 migration adds local revision metadata based on the existing queue.
It preserves entities, deletions, operation IDs, payloads, base versions, timestamps,
and sequence numbers. Future schema versions require a compatible app. Invalid
records stop restoration with an error; no automatic reset or queue deletion occurs.

#### Atomic optimistic writes

Each action returns immediately with its optimistic result. The store serializes
writes in creation order. `commitMutation()` writes only the affected entity and
ordering, appends the operation, and advances the local revision in **one IndexedDB
transaction**. It never rewrites the full queue for an ordinary mutation.

A transaction verifies the previous local revision, so an outdated tab cannot
overwrite newer local data. A retry uses the same operation ID and is idempotent.
Server version and last successful sync time do not change during local edits.
There are no remote synchronization requests in this phase.

The UI says **Saving locally** until the transaction completes. On failure it
retains the optimistic edits and original operations in memory, shows a clear
error, and pauses further edits. **Retry local storage** resumes the ordered writes;
**Download unsaved work** exports a recovery snapshot. Previously committed data
and the durable queue remain unchanged by a failed transaction.

IndexedDB transactions prevent partial entity/queue commits if a tab closes during
a write. Strict durability is requested where supported. Closing or force-killing
a browser before saving completes can still lose edits held only in memory; an
unsaved-work unload warning helps prevent this. No asynchronous unload save is
assumed to succeed. Wait for the saved status before deliberately closing the tab.

```ts
const store = createWorkspaceStore();
await store.persistence.initialize();
store.actions.createItem("Saved locally", "planned"); // immediately visible
await store.persistence.flush(); // resolves after local transactions commit
const saved = await store.persistence.read();
```

`lib/workspace-repository.ts` also retains explicit full-snapshot save/read methods
for import and test use. The application's mutation path uses `commitMutation()`;
startup uses `restoreOrSeed()`. React components never access Dexie directly.

#### Offline application shell

The production `postbuild` script generates `/sw.js` with the build ID and a list
of application chunks, CSS, fonts, icons, and the root HTML document. Installation
succeeds only after the entire shell is cached. The UI then shows **Ready for offline
refresh**. Navigations to the cached workspace and build assets use this cache;
API requests and Next.js RSC responses are excluded. Updates wait for existing
clients to close before replacing the shell, avoiding mixed build assets.

Service workers run only in production, on localhost or HTTPS. Use a different
port from development when testing so a cached production shell cannot obscure
the dev server. First-ever visits still need a network connection to cache the app.

```sh
npm run build
npm run start -- --port 3100
```

Visit `http://localhost:3100`, wait for **Ready for offline refresh**, disconnect
using browser network controls, edit the board, and refresh. The board, order,
renamed stages, queue identities, and inspector versions should remain intact.
Reconnection changes the network indicator without clearing pending operations.

#### Verification

```sh
npm test
npx tsc --noEmit
npm run lint
npm run build
npx playwright install chromium
npm run test:e2e
```

The browser suite starts an isolated production server on port 3100. It tests five
offline mutation types, service-worker-backed refresh, reopening an offline tab,
continued keyboard movement, inspector metadata, storage restrictions, quota
failures and retries, and invalid data without queue loss. Unit/integration tests
also cover concurrent seeding, blocked startup, interrupted writes, schema migration,
idempotent retry, stale tabs, and exact queue ordering. These tests use isolated
databases/browser contexts rather than your development workspace.

### Phase 3 — Mutation Queue

Represent edits as pending operations.

Support:

- enqueue
- retry
- acknowledgement
- removal after successful sync

### Phase 4 — Server Persistence

Implemented with Neon PostgreSQL, Drizzle, and Managed Better Auth. Open
`/account` (or use the account icon on the local workspace) to sign up, sign in,
list online workspaces, and create a workspace with five default stages.

Server workspaces at `/workspaces/:workspaceId` initialize the existing local
store from an authorized snapshot and persist it in an account-specific IndexedDB
cache. Opening a cached workspace restores it immediately, including offline.
Edits apply locally and remain durably queued. Reconnection checks access without
replacing cached data or pending edits; Phase 5 uploads those queued edits.

The existing `/` workspace stays local and accessible without authentication,
in a separate database. Signing in or out preserves stored work. Explicit session
or permission rejection locks account workspaces without clearing their caches;
network failures allow previously authorized offline editing. `/offline` lists
cached workspaces, and the production service worker supports offline reloads
after the **Ready for offline refresh** indicator appears. Migration of existing
local work requires a future explicit flow.

See [server setup and API reference](server/README.md) for environment variables,
migrations, authorization, deletion behavior, snapshot contracts, and tests.

### Phase 5 — Synchronization

Implemented operation uploads through `POST /api/workspaces/:workspaceId/operations`.
All five actions retain their immediate local behavior, persist in IndexedDB, and
upload in order with one request per workspace. Transactions enforce membership,
entity references, stale-version checks, idempotency and authoritative versions.
Acknowledgment removes the accepted operation and advances confirmed metadata in
one IndexedDB transaction. Temporary failures retry with backoff; rejected or
conflicting operations pause dependent work and remain inspectable.

The standalone demo at `/` remains local. Server workspaces use the pull-first
protocol below. [Protocol and verification](server/operations/README.md).

### Phase 6 ? Pull-first Synchronization

Implemented an explicit workspace state machine: `idle`, `offline`, `checking`,
`pulling`, `applying-remote`, `pushing-local`, `synced`, `conflict`, and `error`.

The authorized operation-history endpoint returns bounded batches in strict
server-version order. IndexedDB v4 stores an authoritative confirmed base and a
contiguous `confirmedServerVersion`, independently of the optimistic board and
pending local operations. Both origins share the domain operation applier.

On reconnect, the client catches up before sequentially uploading pending work.
Each remote commit atomically updates entities, queue metadata and cursor.
Acknowledgment gaps trigger another pull; lost responses and interrupted runs
resume without duplicating accepted work. Snapshot recovery preserves pending
intent when history is unavailable. Compatible field changes merge; overlaps pause
only dependent work for explicit resolution without discarding either operation.

Startup, reconnect, workspace activation, new durable edits and manual retry use
one runner under an account/workspace Web Lock. Temporary failures retry with
bounded backoff; permanent failures remain inspectable. The Sync Inspector shows
real phases, confirmed/latest versions, pending/received operations, last completed
sync and current errors. Realtime delivery now feeds this same runner.

### Phase 7 — Conflict Handling

Implemented the [operation-pair conflict matrix](server/operations/CONFLICTS.md),
field-aware server checks, structured conflict responses, and durable IndexedDB
conflict records. Unrelated work continues syncing while affected cards show a
Conflict badge. The item panel and Sync Inspector compare both versions and offer
Keep mine / Use server version, or Keep deleted / Restore item with local edits.

Resolutions replace rejected intent atomically with new operations at current
confirmed versions, retain compatible local fields, and preserve recent history.
Tests cover repeated conflicts, deletion, reload, transaction rollback, edits
during resolution, and lost-acknowledgment snapshot recovery.

### Phase 8 — Realtime and Collaboration UX

Implemented workspace-scoped SSE subscriptions, committed-operation events,
duplicate suppression, ordered recovery after gaps and reconnects, and subscription
cleanup on navigation/offline/account changes. Live operations and HTTP catch-up
share the same IndexedDB transaction and conflict machinery.

The Sync Inspector shows realtime connection state, latest received server version,
latest remote operation, catch-up state, timestamp, and transport errors. Cards and
stage names briefly identify remote changes. Focused item text saves locally on
every change; its uploads wait until the field loses focus, preserving pending
intent for conflict detection. Stage rename drafts retain their original base version.
Ephemeral presence and active-editor indicators are implemented in Phase 9.

`npm run test:online -- realtime.spec.mjs` uses two independent browser contexts
and two users to verify all five mutations without refresh, active-field conflicts,
reconnect, access checks, and workspace isolation. `npm test` covers duplicates,
out-of-order/gapped events, dropped final events, in-flight sync races and disposal.
The realtime database integration test verifies that uncommitted and rolled-back
operations never enter the stream. Tests use the existing named development branch.

### Phase 9 — Hardening

Implemented presence leases, compact idempotency receipts for retained history,
reconnect recovery after exhausted temporary retries, nonblank server titles,
additional local-state validation, recoverable cache backups, additive IndexedDB
v5 migration, differentiated sync messages, and bounded Inspector activity.

Catch-up requests use 100-operation pages (server maximum 500). Cleanup keeps
30 days and at least 1,000 recent versions per workspace; old clients use an
authorized snapshot. `npm run db:prune` compacts at most 500 operations per workspace
per run while retaining small idempotency/tombstone receipts for the workspace's
lifetime. Schedule it daily on the server with database credentials.

Tests cover repeated deliveries, lost acknowledgments before/after pruning,
temporary failures, reconnect storms, deleted targets, unauthorized IDs, invalid
payloads, migrations, corrupted caches, 250-operation catch-up, and workspaces of
100/500/1,000 items. See [verification and demo procedure](HARDENING.md).

## Engineering Principles

### Local state is not a temporary UI cache

For Relay, local state is part of the product architecture.

The app should remain useful when the server cannot be reached.

### The server remains authoritative for shared durable state

Offline-first does not mean serverless state.

Local state and server state must eventually converge.

### Realtime is a transport, not a database

Do not rely on in-memory realtime messages as the source of truth.

### Prefer explicit synchronization rules

Do not add a CRDT library simply because the project is collaborative.

First understand:

- what operations exist
- what can conflict
- which conflicts can be merged
- which conflicts need user resolution

### Avoid unnecessary product scope

Relay is not trying to compete with Linear, Notion, or Trello.

The portfolio value comes from the state model and synchronization architecture, not from having dozens of task-management features.

## Success Criteria

Relay is successful when a user can:

1. Create a workspace.
2. Edit it normally while online.
3. Disconnect from the internet.
4. Continue editing without errors.
5. Refresh while offline and keep their changes.
6. Reconnect.
7. Watch pending operations synchronize.
8. Collaborate with another user.
9. Handle at least one real concurrent-edit conflict without silently losing work.

## Portfolio Story

The project should demonstrate:

- advanced React state design
- optimistic UX
- IndexedDB
- offline-first architecture
- distributed state
- operation queues
- synchronization
- realtime updates
- conflict resolution
- authorization
- resilient network handling

The strongest demo is simple:

Open Relay in two browser windows.

Disconnect one window.

Keep editing in both.

Reconnect.

Show the queued changes synchronizing while the Sync Inspector explains what is happening.
