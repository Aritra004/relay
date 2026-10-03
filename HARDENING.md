# Relay hardening runbook

## State and transport

An edit changes the optimistic board immediately and commits the affected entity,
ordered pending operation, and local revision together in IndexedDB. Only durable
operations upload. One account/workspace Web Lock owns pull-first catch-up and
uploads across tabs. A confirmed cursor represents contiguous accepted history;
the latest advertised version is separate. Duplicate SSE events do not advance it.

HTTP catch-up uses 100-operation pages, validated and applied sequentially. Realtime
uses short SSE leases, heartbeats, an idle watchdog, bounded buffering, jittered
reconnects, and subscription disposal. The board remains available during catch-up.
Temporary sync failures retry with backoff five times; a genuine reconnect or
explicit Retry sync re-arms them. Authorization and validation failures stay paused.
Database transactions set local 15-second statement and 30-second idle transaction
limits, including through the Neon pooler. Interrupted requests cannot retain locks
indefinitely; their original operation IDs remain safe to retry.
The pool handles socket errors even between awaited statements, allowing the next
query to reject without an uncaught connection error.

## Presence

`POST /api/workspaces/:id/presence` accepts only `{ clientId, editingItemId }`.
The verified session supplies user identity; database membership supplies access.
It returns workspace ID, server time, and one entry per person: user ID, display
name, initials avatar, online/offline status, last seen, and optional editing item.
Multiple tabs have independent leases. Closing one tab does not evict the others.

Leases are in `presence_leases`, an **UNLOGGED**, TTL-only table, independent of
durable workspace data, snapshots, operations, and versions. This also works across
multiple application instances connected to the same primary database. Neon stores
unlogged relations on compute-local storage; restart can discard them, which is
appropriate here ([Neon implementation notes](https://github.com/neondatabase/neon/blob/main/docs/core_changes.md)).
Heartbeats run every 10 seconds only while realtime is connected. After 45 seconds
without a heartbeat a user is offline; another viewer observes that within its
next heartbeat (normally at most 55 seconds total). Recent offline entries remain
available in the Inspector and are removed by subsequent heartbeat cleanup after
90 seconds. A client also expires its own cached roster if requests stop succeeding.
`pagehide`/unmount sends a best-effort leave; correctness does not depend on it.

Pointer/keyboard/input interaction in the open item editor updates only an
in-memory editing deadline. Heartbeats carry editing activity while that deadline
is fresh (20 seconds); no per-keystroke network broadcast occurs. Closing the
editor clears it. The next heartbeat shares that change. A locally created item
is not advertised until it exists in the authorized workspace on the server.

## Retention and stale clients

Run `npm run db:prune` daily as a server maintenance job. Default policy keeps both
the most recent **30 days** and at least **1,000 workspace revisions**. Each run
processes workspaces in pages of 50 and compacts at most 500 operations per workspace.
Repeat/schedule runs for a large backlog. There is no publicly callable cleanup API.

Compaction locks the workspace exactly as ingestion does. In one transaction it
copies small receipts (operation ID, author, target, type, canonical SHA-256 body
fingerprint, accepted versions) and deletes eligible replay payloads. The current
workspace tables are the authoritative snapshot. A gap in retained history causes
`snapshot-required`; the snapshot and membership are read consistently.

Receipts remain for the workspace's lifetime. Their storage grows with accepted
operation count, but large text payloads do not. Do **not** independently prune
receipts: arbitrary old retries and deleted-item IDs still need that evidence.
Retrying a compacted operation returns its original acknowledgment; changing its
author/body fails. Missing field history causes an explicit conflict rather than
permission to overwrite newer state. Deleted-item tombstones survive compaction.

On snapshot recovery, a client first looks up its possibly accepted operation.
An archived receipt is verified by safely resubmitting the frozen original body,
then the snapshot is installed with remaining pending intent preserved. Legacy
clients without archived-receipt support should upgrade before log cleanup is enabled.

## Local recovery and schema changes

IndexedDB v5 adds only `recoveryBackups`; the upgrade does not rewrite existing
entities, pending operations, conflicts, timestamps, sequence numbers, or metadata.
Older v1–v4 migrations remain supported. Future schemas fail without clearing data.

Invalid entities/order, invalid versions, malformed operations, and invalid sync
metadata stop normal restore/upload. **Download recovery data** reads raw records
without treating them as trusted domain state. **Recover cached board** on the
workspace error page authenticates again, retrieves a snapshot, and saves an atomic
raw backup before rebuilding the visible cache and replaying validated pending work.
Frozen submission receipts and conflicts survive. If queue order or metadata cannot
be trusted, repair refuses to guess; all original records remain exportable.
Recovery rotates the local generation so older tabs cannot overwrite the rebuilt cache.

Backups are local and are not uploaded. Recovery downloads can contain item content;
store them with the same care as the workspace. A corrupt database that the browser
cannot open may still require browser-level storage recovery; Relay never deletes it
automatically. Keep a tab open while the UI says Saving locally: edits that have not
committed cannot survive a forced browser kill.

## Inspector and user messages

The Inspector exposes connectivity, realtime state/error, confirmed/latest versions,
phase, queue size, conflicts and decisions, last successful sync, recent remote
operations and acknowledgments, retries/errors, and presence count/last seen.
It renders the latest 100 queued operations and at most 20 recent entries of each
history kind; the full durable queue remains retained.

Normal offline editing says `Offline · N changes pending`. Temporary failures say
that retry is safe, authentication failures ask for sign-in, and rejected changes
direct the user to the Inspector. Empty title drafts do not enqueue invalid server
operations; the previous valid title remains saved until a valid replacement exists.

## Verification

```sh
npm test
npm run test:server
npx tsc --noEmit
npm run lint
npm run test:server:integration
npm run test:online -- realtime.spec.mjs
npm run test:devtools
```

Integration/browser tests require `NEON_BRANCH` identifying a non-production branch.
They use isolated transactions or uniquely named fixtures with cleanup. Never point
these tests at production. Run live database and browser suites sequentially; rollback
tests temporarily install failure triggers and must not overlap browser writes.
The realtime suite uses two authenticated browser contexts,
live database/SSE, actual offline toggles, conflicting and compatible edits, presence
expiry, explicit resolution, convergence, Inspector inspection, and a 1,000-item board.

`lib/hardening.test.mjs` exercises IndexedDB restore/filter/durable move/Inspector at
100, 500, and 1,000 items and reports elapsed times. It also catches up 250 operations
in 100-operation pages before uploading local work. These are reproducible diagnostics,
not hardware-independent latency guarantees. The dominant larger-workspace costs are
full snapshot serialization/validation and rendering all cards; virtualization is not
introduced without measurements requiring it. SSE polling costs scale with open tabs.

### Recorded checks (2026-10-03)

- 171 local/domain/IndexedDB/sync tests and 12 server unit tests passed.
- All 15 original/extended live database integration tests passed in an isolated
  run. The additional transaction-limit/rollback check also passed through the pooler.
- Four development browser tests passed, including a 1,000-item cache, filtering,
  pointer drag, keyboard move, durable reload, Inspector, and a 390px mobile layout.
- Observed 1,000-item measurements: authorized server snapshot 1,241ms / 423,623
  bytes; browser cache restore 599ms; a 15-step pointer drag plus optimistic render
  1,837ms. These are development measurements from this machine, not service targets.
- TypeScript and ESLint checks passed. No production build was run.

The final online browser run did **not** pass: database/auth DNS resolution failed,
connections terminated, and authentication requests timed out. A later `db:check`
also failed; the connected Neon API returned `project not found` for the project in
`.neon`. This may indicate a removed or inaccessible project; verify the configured
development project before rerunning. The new between-statements connection-loss
regression remains unverified against the live service. The full two-user demo,
production offline-refresh suite, deployed auth redirects, and production migrations
remain release checks. No production database was migrated.

Live-test fixture cleanup was also interrupted by that outage. Inspect development
fixtures before the next demo. Online tests use unique `@example.invalid` addresses
and save their exact addresses in `test-results/**/fixture-emails.json`; preserve
those manifests before starting another Playwright suite if cleanup fails. Remove
only identified test fixtures, never unrelated workspace or account data.

Production offline refresh requires a production build and service worker. When a
build is explicitly authorized, run `npm run build` and then `npm run test:e2e`.
Development-server reloads cannot prove service-worker offline refresh. The production
suite covers local/account caches, exact pending IDs, offline refresh/reopening, quota
failure, blocked migration, and corrupted data. The app must first show **Ready for
offline refresh**; a first-ever offline visit has no cached application shell.

## Portfolio demo

1. Sign two different users into the same workspace; verify both appear online.
2. Disconnect A. Edit a title, create an item, and wait for local saving to finish.
3. In B, edit the first item's description (compatible) and title (conflicting).
4. Wait for A's presence to expire without logout.
5. Reconnect A. Watch remote catch-up, independent queued uploads, and the conflict.
6. Open the conflicted item, compare both versions, and choose Keep mine/Use server.
7. Confirm both browsers show the same title, description, order, and item count.
8. Open the Inspector to show versions, empty pending queue, conflict decision,
   recent operations/acknowledgments, realtime connection, and presence.
9. For the production demo, also refresh A while offline after local saving completes.

## Release checks

- Apply checked-in SQL migrations through the direct connection; `0004` adds presence
  and receipts. It has been exercised on the configured development branch.
- Schedule retention only after deploying snapshot/archived-receipt support.
- Set database URLs, auth origin/cookie secret, and production auth trusted domains.
- Verify signed-out/expired-session redirects and membership rejection on the deployed origin.
- Build only when explicitly requested; run the production offline suite against that build.
- Sample cards and mock collaborators seed development only. Simulation/reset controls
  require `NODE_ENV=development`; existing user caches are always preserved.
- Error logs include safe error types/operation identifiers, never passwords, tokens,
  SQL text, or database connection strings. Configure host log collection for deployment.
- Check desktop and narrow viewport layouts on the deployed build. A local development
  browser run is not evidence of production deployment or hosting configuration.
