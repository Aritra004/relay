# Relay

Relay is a collaborative workspace that keeps working when the network does not.

You organize work across five stages, from idea to shipped, together with other people in real time. Pull the plug and nothing about the experience changes: edits still land instantly, survive a refresh, and queue up on the device. When the connection returns, Relay pulls in what your collaborators did while you were away, uploads your pending changes in order, and tells you plainly when two people changed the same thing.

The board is deliberately small. The interesting part is the distributed state underneath it.

**Stack:** Next.js 16 (App Router) · React 19 · TypeScript · Tailwind CSS 4 · Neon Postgres + Drizzle · Neon Auth · Dexie (IndexedDB) · Server-Sent Events · a hand-written service worker

## Why this exists

Most collaboration tools assume the network is there. Relay assumes it will disappear at the worst possible moment, and treats "offline" as a normal product state rather than an error screen.

I built it to work through the problems that make local-first software hard in practice, without a CRDT library or a sync platform hiding the answers:

- optimistic updates that are also durable
- a mutation queue that survives reloads and browser restarts
- synchronization that stays correct under retries, duplicate delivery, and lost responses
- conflict handling that never silently discards someone's work
- realtime updates that are a transport, not a second source of truth
- reconnection that assumes the world changed while you were gone

Every rule is explicit and readable in the codebase. If you want to know what happens when two people move the same card, there is a table for that.

## The sixty-second demo

1. Sign in from two browsers as two members of the same workspace. Both show up as online.
2. Disconnect browser A. Rename a card, create another, drag one to a new stage. Everything applies immediately, and the footer confirms the changes are saved on this device.
3. In browser B, edit the first card's description (a compatible change) and its title (a conflicting one).
4. Reconnect A. Watch it catch up on B's work first, then upload its own queue, then flag the one real conflict with both versions side by side.
5. Pick **Keep mine** or **Use server version**. Both browsers converge on the same board.
6. Open the Sync Inspector at any point to see the real phase, confirmed and latest versions, the pending queue, recent acknowledgments, and the realtime connection.

Step 2 also works if you refresh while offline. The production build installs a service worker that serves a data-free shell, and the shell opens your account's local cache.

## How it works

### Every edit is an operation

There are exactly five mutations: `CREATE_ITEM`, `UPDATE_ITEM`, `MOVE_ITEM`, `DELETE_ITEM`, and `RENAME_STAGE`. Each is a small, serializable record carrying a client-generated UUID, the target entity, a payload, the base version it was made against, and a timestamp that is informational, never authoritative.

Every board action follows the same path: create the operation, apply it through one pure function, publish the new state, then persist the state and the operation together in a single IndexedDB transaction. Replaying a stored operation against the same snapshot gives the same result, and that property is what makes everything downstream possible.

### Local first, then the server

Each signed-in account gets its own IndexedDB database on the device, so two people sharing a laptop never mix queues. A workspace opens from that cache instantly, online or offline. A fresh snapshot is only fetched when there is no cache yet or the history a client needs has been pruned.

The store keeps three things apart: the confirmed server projection, the list of pending local operations, and the visible board, which is the confirmed projection with local work replayed on top. That separation is what lets the UI stay editable while sync does something complicated underneath.

### Pull before push

Reconnection is an explicit state machine: `idle`, `offline`, `checking`, `pulling`, `applying-remote`, `pushing-local`, `synced`, `conflict`, `error`. The Sync Inspector shows the real phase, not a decorative spinner.

On every reconnect, workspace activation, or new durable edit, one runner (held under a Web Lock per account and workspace) first downloads the remote history it missed in bounded, strictly ordered pages, applies it, and only then uploads pending operations one at a time. Each acknowledgment removes the operation and advances the confirmed version in the same transaction. If an acknowledgment reveals a gap, the runner pulls again. If the server has pruned the history a client needs, it recovers from an authorized snapshot without dropping pending intent.

Retries are safe by construction. The server keeps a receipt per operation ID and returns the original acknowledgment for a matching retry, so a lost response never creates a duplicate card.

### Conflicts are decisions, not surprises

The server checks every operation against the confirmed state field by field. Disjoint changes merge automatically: you can edit a description while someone else moves the card. Overlapping intent is a conflict: two title edits, two competing moves, or an edit against a deletion.

A conflict pauses only that entity and anything ordered relative to it. Unrelated cards keep syncing. The rejected intent, both values, and the versions involved are stored durably, so a conflict survives a refresh and even a browser restart. Opening the card or the inspector shows both versions and offers **Keep mine** or **Use server version**, or for a remote deletion, **Keep deleted** or **Restore item with local edits**. Resolving creates a new operation at the latest confirmed version. Nothing is decided by clock or arrival order.

The full matrix of operation pairs is in [server/operations/CONFLICTS.md](server/operations/CONFLICTS.md).

### Realtime is a transport, not the truth

Each open workspace subscribes to an authenticated Server-Sent Events route that tails the committed operation log in Postgres and emits small `operation.accepted` events. Uploads still go over HTTP. A live event goes through exactly the same apply-and-persist path as HTTP catch-up, duplicates are suppressed by operation ID, and a gap or dropped connection simply triggers an ordered pull. Missing a message is never fatal.

### Presence stays ephemeral

Online collaborators and "currently editing" markers come from short-lived Postgres leases, with a heartbeat every 10 seconds and expiry after 45. Presence never touches workspace versions or IndexedDB. It is nice to have, so it is kept out of the durable path on purpose.

### Offline reloads

The production build generates a service worker that precaches the shell and the immutable build assets. A workspace URL that fails to load falls back to a public, data-free shell at the same address, which then opens the account's local cache. APIs, auth pages, and personalized HTML are never cached. In development the worker is deliberately not installed.

## Project layout

```
app/                     Routes: /, /account, /auth/*, /workspaces/[id], /offline, /api/**
components/workspace/    Board UI, item editor, Sync Inspector, presence, conflict resolution,
                         workspace-store.ts (state and actions), apply-workspace-operation.ts
components/account/      Home hand-off, account page, sign-in form, cached workspace list
lib/                     Dexie schema and repository, sync runner, realtime and presence clients,
                         conflict rules, HTTP contracts, local account registry
server/                  Drizzle schema and migrations, services, authorization, operation
                         history and retention, SSE stream, presence leases
scripts/                 Service worker template and build step, operation-log pruning
```

## Routes and API

| Route | Purpose |
| --- | --- |
| `/` | Reopens the last workspace this device opened, otherwise hands off to your account |
| `/account` | Sign in, list online workspaces, create one |
| `/workspaces/:id` | A shared workspace, served from the local cache first |
| `/offline` | Workspaces cached on this device, and the offline fallback shell |

| Endpoint | Notes |
| --- | --- |
| `GET /api/session` | Current user |
| `GET /api/workspaces`, `POST /api/workspaces` | List and create |
| `GET /api/workspaces/:id` | Consistent snapshot |
| `GET /api/workspaces/:id/operations?afterVersion=&limit=` | Contiguous history in bounded pages |
| `POST /api/workspaces/:id/operations` | One operation, idempotent on retry |
| `GET /api/workspaces/:id/events` | SSE stream of committed operations |
| `POST`, `DELETE /api/workspaces/:id/presence` | Heartbeat and leave |
| `/api/auth/*` | Neon Auth proxy |

Every private endpoint verifies the session and workspace membership on the server. A user ID supplied by the client is never trusted for authorization.

## Running it locally

You need Node 20 or newer and a Neon project with a development branch and Neon Auth enabled.

```sh
npm install
cp .env.example .env.local      # fill in the Neon connection strings and auth values
npm run db:migrate
npm run db:check
npm run dev
```

Open http://localhost:3000, create an account, and create a workspace. A second member is currently added at the database level; a member-management UI is on the list below.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | Pooled connection for application traffic |
| `DATABASE_URL_UNPOOLED` | Direct connection for migrations |
| `NEON_AUTH_BASE_URL` | Neon Auth endpoint for the branch |
| `NEON_AUTH_COOKIE_SECRET` | Random secret, at least 32 characters |
| `NEON_BRANCH` | Development branch name, required by destructive integration tests |

`npm run build` also generates `public/sw.js` for the offline shell. In production, schedule `npm run db:prune` daily. It compacts old operation history while keeping 30 days and at least 1,000 recent versions per workspace, plus the small receipts that keep retries idempotent for the life of the workspace.

## Testing

```sh
npm test                         # 171 node:test cases: store, IndexedDB persistence, sync runner,
                                 # realtime ordering, conflicts, recovery (fake-indexeddb, no server)
npm run typecheck
npm run lint
npm run test:server              # server services against the schema
npm run test:server:integration  # against the development Neon branch (NEON_BRANCH)
```

The tests lean toward the failure modes that actually matter: duplicate delivery, out-of-order and gapped events, lost acknowledgments before and after pruning, edits made in the middle of a pull, stale tabs, corrupted caches, transaction rollback, and catch-up over hundreds of operations. Playwright configs in the repository root are set up for browser runs against the production build, the development server, and a two-user online session.

## Design

Relay is intentionally not a dark developer console or a rounded-card kanban clone. The visual language is a "state ledger": warm paper background, one blue accent used only where it means something, monospaced labels for system state, and a LOCAL to SERVER path in the footer that visibly breaks when you go offline. Every sync state has an icon and a word, never just a color. The full system is in [DESIGN.md](DESIGN.md).

## Documentation

- [Server setup and API reference](server/README.md)
- [Operation synchronization protocol](server/operations/README.md)
- [Conflict rules](server/operations/CONFLICTS.md)
- [Workspace realtime](server/realtime/README.md)
- [Hardening and demo runbook](HARDENING.md)
- [Design system](DESIGN.md)
- [Implementation history](docs/implementation-history.md), the phase-by-phase working notes this README replaces

## Limitations

- Members are added at the database level. There is no invite or member-management UI yet.
- The server does not model item labels or assignees, so items opened from the server use local defaults.
- Light theme only for now.
- The original standalone local board was removed, and there is no import path for data created in it.

## Principles that shaped it

- Local state is durable product state, not a cache to throw away.
- The server stays authoritative for shared state, and the client stays usable without it.
- Prefer an explicit rule you can explain over a clever merge you cannot.
- Add a version number only when it answers a specific synchronization question.
- Keep the scope small so the hard part stays visible.
