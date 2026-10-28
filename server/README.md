# Relay server persistence

The Next.js Node runtime connects to the existing Relay Neon project through a
pooled PostgreSQL connection. The local `.neon` context selects `development`.
Production is unchanged. Managed Better Auth on that same branch owns passwords
and sessions; Relay maps verified provider IDs into its own `users` table.

## Local setup

1. Install dependencies with `npm install`.
2. Link the Relay project with the Neon CLI, then use
   `neon checkout development --create`. Existing development branches are reused.
   `neon.ts` declares Auth; checkout pulls the branch's variables into `.env.local`.
3. Add `NEON_AUTH_COOKIE_SECRET` to `.env.local`, generated with
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('base64url'))"`.
4. Run `npm run db:migrate`, `npm run db:check`, then `npm run dev`.
5. Open `/auth/sign-up` or `/account`. The account icon on `/` also opens it.

`.env.example` documents the variables. `.env.local` and `.neon` are Git-ignored.
Never prefix database credentials or the cookie secret with `NEXT_PUBLIC_`.
Use `DATABASE_URL` for pooled application traffic and `DATABASE_URL_UNPOOLED`
for migrations. Both connections verify TLS certificates and hostnames.

The development auth configuration permits email/password signup without email
verification. The form also supports the provider's OTP verification flow when
enabled. Before deploying, register the deployed origin with Neon Auth, configure
the provider's production email settings, and inject server environment variables.
See the [Neon Next.js guide](https://neon.com/docs/auth/quick-start/nextjs-api-only)
and [production checklist](https://neon.com/docs/auth/production-checklist).

## Layers and boundaries

- `app/api/**/route.ts`: HTTP parsing, verified identity, services, JSON responses.
- `server/auth`: provider configuration and authoritative session verification.
- `server/workspaces`: workspace transactions, validation and permission rules.
- `server/operations`: operation validation, transactional mutations and idempotency.
- `lib/operation-contract.ts`: shared operation and acknowledgment schemas.
- `lib/workspace-sync.ts`: pull-first state machine, ordered uploads, locks and retry scheduling.
- `lib/sync-persistence.ts`: atomic confirmed-state replay and snapshot recovery.
- `server/db`: the central pool, typed queries, schema and migration files.
- `lib/online-workspace.ts`: browser-safe HTTP types and fetch helper.
- `lib/server-snapshot.ts`: validates and adapts snapshots to the local model.
- `lib/server-workspace.ts`: opens the local store and checks server access.
- `lib/local-account.ts`: durable account status and account-scoped repositories.

No React component imports the database client. Runtime server modules use
`server-only`; ESLint rejects server imports in browser modules and database
imports in route handlers/pages. Auth calls use the SDK's same-origin Next.js
proxy. Private responses are `Cache-Control: private, no-store`. The offline
service worker never caches account HTML, auth endpoints or workspace APIs.

`proxy.ts` protects `/account`. Workspace routes are public, data-free shells so
cached workspaces can open offline without a server session check. Every private API independently
verifies the provider session (bypassing cached session cookies), provisions the
application identity by `(auth_provider, auth_user_id)`, and checks membership.
Client-supplied user IDs and roles are rejected. Email is profile data, never an
authorization key. A member may read/edit; only an owner may manage a workspace
or its members. Operation ingestion checks membership inside its transaction,
holding a lock through the commit. Item and stage edits use the operation endpoint;
member management is not exposed yet.

## Endpoints

| Endpoint | Result |
| --- | --- |
| `GET /api/session` | `{ user: { id, name, email } }`, or 401 |
| `GET /api/workspaces` | `{ workspaces: [{ id, name, version, role, createdAt, updatedAt }] }` |
| `POST /api/workspaces` | Body `{ "name": "Product team" }`; 201 with `{ workspace, membership }` |
| `GET /api/workspaces/:workspaceId` | Authorized, consistent workspace snapshot |
| `GET /api/workspaces/:workspaceId/operations?afterVersion=X&limit=100` | Authorized contiguous history; bounded pages or snapshot-required |
| `POST /api/workspaces/:workspaceId/operations` | One validated operation; original acknowledgment on matching retries |
| `GET /api/workspaces/:workspaceId/events` | Authorized SSE updates/checkpoints |
| `POST /api/workspaces/:workspaceId/presence` | Expiring tab heartbeat and current collaborator roster |
| `DELETE /api/workspaces/:workspaceId/presence` | Best-effort leave for this authenticated tab |
| `/api/auth/*` | Managed Better Auth SDK proxy |

Snapshots include `workspace`, `version`, ordered `stages` and `items`, `members`
(user ID, display name, role and join time), current-user `membership`, `stageOrder`,
and `itemOrderByStage`. IDs are stable UUIDs, versions are JSON-safe numbers and
timestamps serialize as ISO strings. The frontend validates the snapshot and
initializes an absent local workspace atomically. Existing caches are retained,
until the sync engine reconciles them through ordered operations or snapshot recovery.

Snapshot membership and all rows are read in one **repeatable-read, read-only**
transaction. Workspace creation inserts workspace, owner and five default stages
in one transaction. A failed stage insert rolls everything back.

Errors have `{ error: { code, message } }`. Anonymous access returns 401,
owner-only permission failures return 403, missing/non-member workspaces both
return 404, and invalid input returns 400. Workspace JSON payloads are limited to 4 KiB;
cross-origin mutations are rejected. Unexpected failures never return SQL or
connection details.

Operation requests allow 128 KiB and return structured acceptance/rejection
results with version and retry information. See the [operation protocol](operations/README.md)
for payloads, transaction ordering, error codes, local acknowledgment and recovery.

## Cached workspaces and offline access

Opening `/workspaces/:workspaceId` restores the active account's cached workspace
before checking the server. A first visit requires a verified session and an
authorized snapshot. UUIDs and server versions survive adaptation into the
existing central store; edits use the same immediate operation application and
atomic IndexedDB persistence as the local board.

Each account uses a `relay-account-<userId>` database with the seven-table v5
schema, including a separate confirmed server base and raw recovery backups. The local board retains its separate `relay` database. The `relay-accounts`
database stores the last verified account and explicit signed-out/expired state;
it contains no credentials and grants no server access. Signing out preserves
pending work and blocks cached account access, including in other open tabs.

Network failures, timeouts, rate limits and server outages keep a previously
authorized cache editable. An explicit 401 requires sign-in; 403/404 locks that
workspace without deleting its data. These known denials remain blocked offline.
Reconnect checks authorization again and resumes queued uploads without replacing
the live store. Only valid operation acknowledgments remove queued edits.
Fetching a snapshot records `lastSnapshotAt` on
initialization, separately from `lastSyncedAt`.

In production, the service worker precaches `/offline`, a generic shell without
account data. Failed workspace document navigations fall back to that shell at
the requested URL; it opens the account's IndexedDB cache. `/offline` also lists
cached workspaces. APIs, auth pages, account HTML and private workspace responses
are never cached by the worker. Wait for **Ready for offline refresh** before
disconnecting for a reload. Development deliberately does not install a worker.

Synchronization pulls missed remote operations before draining local work.
Missing history triggers snapshot recovery while preserving pending operations.
Conflicts pause affected entities and their dependencies for explicit resolution.
The [workspace SSE transport](realtime/README.md) streams committed operations and
uses the same reconciliation path. Importing the demo remains future work. Server item labels/assignees are not
modeled yet, so imported items use the local defaults.

## Schema and migrations

The six public tables are `users`, `workspaces`, `workspace_members`,
`workflow_stages`, `work_items`, and `operations`. Auth tables remain owned by
Neon; Drizzle does not manage the `neon_auth` schema.

- Membership uses a composite primary key and an inverse user/workspace index.
- Stage/item indexes begin with workspace ID and support ordered reads.
- A composite item/stage foreign key forbids stages from another workspace.
- Operation IDs are primary keys. The unique `(workspace_id, server_version)`
  index supports ordered incremental retrieval and prevents sequence collisions.
- A workspace deletion cascades to its memberships, stages, items and operations.
  Stage deletion cascades to its items. User deletion is restricted while authored
  data or memberships still refer to it; a future account deletion workflow must
  explicitly handle ownership/history. Operation target IDs deliberately have no
  entity FK so accepted deletion records survive the target.
- Operation payloads are null for deletes; base versions are null for creations.
  Updates, moves, deletes and stage renames require numeric entity base versions.
- Workspace and stage versions start at zero; accepted item creation starts at 1.
  `serverVersion` orders accepted operations; `entityVersion` records the affected
  entity's resulting counter, including the final version of a deleted item.
  All increments and the accepted log record commit in one transaction.
- Entity timestamps are server-assigned. The operation log records both client
  creation time and server acceptance time. Mutation services update `updatedAt`.

After changing `server/db/schema/index.ts`:

```sh
npm run db:generate  # writes reviewable SQL and schema metadata
npm run db:migrate   # applies committed migrations through the direct connection
npm run db:check     # SELECT 1 through the application's server database client
```

Review generated SQL before applying it. Start on a development/test Neon branch.
Do not use `drizzle-kit push` in place of the migration history.

## Verification

```sh
npm test                     # local store, cache, operations and auth/offline boundaries
npm run test:server          # validation, permissions and HTTP boundary
npm run test:server:integration # actual PostgreSQL constraints and transactions
npm run test:online          # actual provider + Next.js + browser; dev port 3102
npm run typecheck
npm run lint
npm run test:e2e             # production service worker; build separately first
```

Integration tests require `NEON_BRANCH` to name a development/test branch. Database
fixtures and simulated failure triggers are transactionally rolled back. The
concurrency test commits unique fixtures and removes only those fixtures afterward.
The online test creates two unique `example.invalid` accounts and workspaces, then
removes exactly those fixtures, including their provider accounts/sessions. Run
it only on a development branch where email verification is disabled. Traces are
disabled to avoid recording auth credentials. It checks real signup, signin,
reload, signout, private workspace isolation, API input rejection, browser secret
exclusion, preservation of an existing pending local edit, real operation uploads,
lost acknowledgments, all five mutations, and the inspector's confirmed history.

The production build is intentionally not run automatically. The production
service-worker/offline-shell suite requires an explicitly requested build.
