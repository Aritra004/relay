# Relay — Agent Instructions

## Project Overview

Relay is an offline-first collaborative workspace.

Users can organize work across workflow stages, collaborate with other users, continue editing while offline, and synchronize pending changes when connectivity returns.

The engineering focus is distributed state rather than project-management feature breadth.

The core areas are:

- optimistic UI
- local persistence
- IndexedDB
- operation queues
- synchronization
- realtime updates
- conflict handling
- reconnection
- authorization
- presence

## Primary User Journey

The core flow is:

1. User opens a workspace.
2. User edits items.
3. UI updates immediately.
4. Local state persists.
5. Mutations are represented as operations.
6. Operations synchronize with the server.
7. Another collaborator receives remote updates.
8. Network connectivity may disappear.
9. User continues working offline.
10. Pending operations synchronize when connectivity returns.
11. Conflicts are handled explicitly without silent data loss.

Every architectural decision should support this flow.

## Current Tech Direction

Use the existing project stack unless explicitly instructed otherwise.

Expected technologies:

- Next.js
- React
- TypeScript
- Tailwind CSS
- PostgreSQL
- Neon
- Drizzle ORM
- IndexedDB

A small IndexedDB helper library such as Dexie may be used if it clearly reduces complexity.

Do not introduce a CRDT framework, state-sync framework, or large realtime platform before the synchronization model has been intentionally designed.

## Architecture Philosophy

Prefer explicit state transitions over hidden magic.

Relay is a learning and portfolio project.

Important synchronization behavior should be understandable from the codebase.

Avoid:

- unnecessary microservices
- premature event sourcing
- premature CRDT adoption
- large state-management frameworks without a concrete need
- abstract repository/service/factory layers
- realtime systems that become the source of truth

The first correct synchronization protocol is more valuable than a theoretically advanced architecture the developer cannot explain.

## State Model

Relay has three important categories of state.

### Server State

Durable shared state stored in PostgreSQL.

Examples:

- workspaces
- members
- stages
- items
- accepted operations

### Local Durable State

Persisted in IndexedDB.

Examples:

- cached workspace
- pending operations
- local operation metadata
- last known server version

### Ephemeral UI State

Kept in React memory.

Examples:

- open panel
- current selection
- drag state
- active filter
- temporary form state

Do not mix these responsibilities unnecessarily.

## Local-First Principle

The UI should not require a successful round trip before reflecting a user's edit.

For supported mutations:

User action  
-> local UI update  
-> local persistence  
-> operation queued  
-> server synchronization

The server response confirms the change but should not be the first time the user sees it.

## Offline Principle

Offline mode is a supported product state.

Do not disable the entire interface when the network disappears.

Supported edits should continue to work locally.

Pending changes must survive:

- route changes
- reloads
- temporary browser restarts where IndexedDB persists

## Operations

Mutations should eventually be represented as explicit operations.

Examples:

- CREATE_ITEM
- UPDATE_ITEM_TITLE
- UPDATE_ITEM_DESCRIPTION
- MOVE_ITEM
- DELETE_ITEM
- CREATE_STAGE
- RENAME_STAGE
- REORDER_STAGE

Each operation should have enough metadata to support:

- unique identity
- workspace identity
- target entity
- operation type
- payload
- creation time
- originating user/client
- base version where needed
- acknowledgement state

Do not create a giant generic operation abstraction before concrete mutation types exist.

## Idempotency

Synchronization must assume retries can happen.

A repeated operation must not create duplicate effects.

Operation IDs should be unique and persisted.

The server should be able to recognize already-applied operations.

## Ordering

Do not assume network delivery order always matches creation order.

Operations should carry enough metadata to support deterministic processing where order matters.

If a specific mutation depends on another operation, that dependency should be explicit or naturally enforced by entity/version rules.

## Versions

Use versions deliberately.

Potential uses include:

- workspace version
- item version
- server revision
- base version for mutation validation

Do not add version numbers without defining what they mean.

A version must answer a specific synchronization question.

## Realtime

Realtime transport delivers remote changes.

It is not the source of truth.

A client receiving a realtime message should still be able to recover if:

- a message is missed
- the connection drops
- messages arrive twice
- the browser sleeps
- the server restarts

PostgreSQL remains durable server state.

## Reconnection

Reconnect logic must be robust.

On reconnect:

1. determine current server state/version
2. determine local pending operations
3. fetch any missed remote changes if needed
4. reconcile
5. push pending local operations
6. confirm acknowledgement
7. update local version/state

The exact protocol may evolve, but reconnect should never assume no changes occurred while offline.

## Conflict Handling

Do not silently overwrite meaningful concurrent edits.

Start with explicit conflict rules.

For example:

- different fields changed -> merge if safe
- same scalar field changed -> conflict or deterministic policy
- item moved by two users -> define a rule
- item deleted remotely but edited locally -> explicit handling required

Document each conflict rule.

Only introduce CRDTs later if the concrete collaboration requirements justify them.

## Database

Use Neon PostgreSQL with Drizzle ORM.

Likely initial tables:

### workspaces

- id
- name
- createdBy
- createdAt
- updatedAt

### workspace_members

- workspaceId
- userId
- role
- joinedAt

### workflow_stages

- id
- workspaceId
- name
- position
- createdAt
- updatedAt

### work_items

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

### operations

- id
- workspaceId
- entityType
- entityId
- operationType
- payload
- baseVersion
- createdBy
- createdAt

The schema should evolve with real requirements.

Do not create speculative tables for future features.

## Authorization

Authentication and authorization are separate concerns.

All private server operations must verify that the current user is a member of the target workspace.

Never trust a user ID supplied by the client for authorization decisions.

Workspace membership must be verified server-side.

## IndexedDB

IndexedDB stores durable local state.

Keep access behind a small, understandable module.

Do not scatter raw IndexedDB transactions throughout components.

Potential responsibilities:

- read cached workspace
- persist workspace snapshot
- enqueue operation
- list pending operations
- mark operation acknowledged
- delete acknowledged operation
- store local version metadata

## React

Prefer predictable data flow.

Do not put the entire synchronization engine into one giant context provider.

Separate:

- domain state
- persistence
- sync logic
- UI state

Use Client Components only where interactivity requires them.

Keep server-only code server-side.

## TypeScript

Use strict TypeScript.

Avoid `any`.

Do not suppress type errors to move faster.

Domain types should clearly represent:

- Workspace
- WorkspaceMember
- WorkflowStage
- WorkItem
- Operation
- SyncState
- Conflict

## UI Principles

Follow DESIGN.md.

The interface should feel like a State Ledger, not a generic SaaS dashboard.

Important visual states:

- synced
- syncing
- offline
- pending
- conflict
- remote collaborator activity

Never rely on color alone to communicate them.

## Sync Status

The visible sync status must reflect real system state.

Do not fake:

`SYNCED`

when operations are still pending.

Possible states:

- synced
- syncing
- offline
- reconnecting
- conflict
- error

The state machine should be explicit.

## Sync Inspector

The Sync Inspector should expose real synchronization information.

Potential fields:

- connection state
- local version
- server version
- pending operation count
- recent operations
- retry state
- last successful sync

Do not populate it with decorative fake telemetry once the backend exists.

## Error Handling

Expected failures should be modeled intentionally.

Examples:

- offline
- server unavailable
- operation rejected
- stale version
- authorization failure
- malformed operation
- conflict
- realtime disconnect

Do not silently swallow sync errors.

At the same time, temporary network failures should not produce alarming modal dialogs.

## Retry Behavior

Retries need limits and backoff.

Avoid tight retry loops.

Operations should not be duplicated because a response was lost.

Retry state should be inspectable.

## Performance

Do not prematurely optimize.

However, avoid obvious issues such as:

- rewriting the entire IndexedDB database for one field change
- loading the full operation history forever
- rendering every workspace item on every keystroke
- sending full workspace snapshots for every mutation
- reconnect loops with no backoff

## Dependencies

Before adding a dependency, ask:

1. Is there a concrete requirement?
2. Can the platform already solve this clearly?
3. Does the dependency hide architecture we are intentionally trying to learn?
4. Is it actively maintained?
5. Does it make the code easier to explain?

Do not add Yjs, Automerge, Redux, Zustand, Liveblocks, Pusher, Ably, or similar tools automatically.

They may become appropriate later, but only after the requirement is explicit.

## Testing Priorities

Highest-value tests include:

- offline edit persistence
- operation queue persistence
- duplicate operation handling
- reconnect
- missed realtime updates
- concurrent edits
- conflict resolution
- authorization
- stale client recovery

Do not write superficial tests only to increase coverage.

## Scope Control

Do not automatically add:

- billing
- AI features
- calendars
- file storage
- video calls
- advanced permissions
- dozens of workflow features
- complex reporting
- integrations

The project is about local-first collaboration.

## Initial Milestone

The first milestone should be frontend-only.

Build:

- application shell
- workspace layout
- workflow stages
- work items
- item detail panel
- sync status control
- Sync Inspector shell
- offline/pending visual states

Use mock data.

Do not connect PostgreSQL or IndexedDB until the interaction model is stable.

## Definition of Done

The finished project should prove:

1. A workspace can be edited online.
2. Supported edits update optimistically.
3. Workspace state persists locally.
4. The app remains usable offline.
5. Pending operations survive reloads.
6. Reconnection synchronizes pending work.
7. Connected collaborators receive remote updates.
8. Missed updates can be recovered.
9. At least one real concurrent-edit conflict is handled deliberately.
10. No meaningful user work is silently discarded.

## Agent Behavior

When modifying the project:

- inspect existing code first
- preserve working behavior
- make focused changes
- follow the current milestone
- explain significant sync decisions
- call out assumptions
- call out data-loss risks
- avoid unnecessary dependencies
- avoid premature abstractions
- avoid unrelated refactors
- do not replace explicit sync logic with a large framework without instruction
- Never run npm run build automatically. Only run it when explicitly instructed by me.

When multiple approaches are valid, prefer the simplest approach that remains correct under:

- offline edits
- retries
- duplicate delivery
- reconnect
- concurrent edits
