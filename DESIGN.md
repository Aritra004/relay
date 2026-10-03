# Relay — Design System

## 1. Design Direction

Relay should not look like a generic project-management SaaS.

Avoid:

- Trello-style rounded cards
- purple gradients
- giant dashboard metrics
- glassmorphism
- floating decorative blobs
- oversized sidebars
- excessive pill-shaped controls
- generic kanban-board templates
- playful productivity illustrations
- overuse of shadows
- AI sparkle motifs

The design concept is:

# The State Ledger

Relay should feel like a live working document that records how shared state changes over time.

The interface combines ideas from:

- field notebooks
- editorial layout
- transit maps
- revision history
- whiteboards
- source-control timelines

The product should feel calm, precise, collaborative, and slightly experimental.

The most important visual idea:

**work moves through states, and synchronization leaves visible traces.**

---

## 2. Default Theme

Unlike many developer-oriented products, Relay should default to a light interface.

This deliberately separates it from dark developer consoles.

Use a warm paper-like background rather than pure white.

Suggested direction:

Background:

`#F4F1EA`

Primary surface:

`#FAF8F3`

Secondary surface:

`#EEEAE1`

Primary text:

`#1D211F`

Secondary text:

`#626863`

Muted text:

`#8D918D`

Border:

`#D6D2C8`

Strong border:

`#B9B5AA`

Dark mode may be added later, but the light theme should be the primary visual identity.

---

## 3. Product Accent

Use one main accent:

### Relay Blue

Suggested direction:

`#2F5BFF`

This color represents:

- confirmed synchronization
- active selection
- local operation paths
- focused controls
- presence highlights

Use it sparingly.

The product should not become blue everywhere.

---

## 4. Secondary State Colors

Use semantic colors only where they communicate state.

### Offline / Pending

Warm amber:

`#C98318`

### Conflict

Muted coral/red:

`#C64E45`

### Synced

Relay Blue or a restrained green where needed.

### Remote collaborator activity

Soft violet or teal may be used in tiny amounts, but never as broad background decoration.

---

## 5. Typography

Use two type systems.

### Interface Typeface

Recommended:

**Geist Sans**

Use for:

- navigation
- headings
- item titles
- buttons
- dialogs
- labels

### System Typeface

Recommended:

**Geist Mono**

Use for:

- versions
- operation IDs
- timestamps
- sync state
- network state
- technical metadata

The visual distinction should make the sync layer feel inspectable without turning the whole product into a terminal.

---

## 6. Layout Philosophy

Do not build the application from floating cards.

Use:

- structured regions
- thin dividers
- whitespace
- alignment
- typographic hierarchy
- small state marks

The interface should feel like a working surface.

Think:

**document + map**

rather than:

**dashboard + cards**

---

## 7. Main Workspace Layout

Desktop layout:

Compact navigation rail  
|  
Workspace header  
|  
Workflow surface

The workflow surface contains horizontal stages:

`IDEA | PLANNED | BUILDING | REVIEW | SHIPPED`

But stages should not look like giant rounded columns.

Use subtle vertical rules and a shared canvas.

Each stage is a lane in the same workspace.

---

## 8. Workflow Lanes

A lane should have:

Stage name

Item count

Optional collaborator presence

Then a stack of work items.

Example:

`BUILDING                         3`

`────────────────────────────────`

`Fix offline cache invalidation`

`Mina · edited 2m ago`

`────────────────────────────────`

`Add sync retry backoff`

`You · pending`

Do not put every item inside a thick bordered card.

Items can look like entries on a ledger:

- thin separators
- compact padding
- subtle hover surface
- square or very slightly rounded corners

---

## 9. Work Items

Work items should feel like movable records, not colorful sticky notes.

Each item may show:

- title
- assignee
- tiny status marker
- last edit time
- sync state when relevant

Example:

`● Fix conflict merge rule`

`  You · 4m ago`

For unsynced local edits:

`◐ Add offline persistence`

`  You · pending sync`

The state marker matters more than decorative icons.

---

## 10. Dragging

Dragging an item should make its movement through the workflow obvious.

Use:

- a clear insertion line
- lightweight elevation during drag
- subtle stage highlight

Avoid:

- large shadows
- rotation gimmicks
- exaggerated spring animations

Movement should feel controlled and precise.

---

## 11. Signature Visual: State Path

Relay should have one visual motif that appears throughout the product.

A thin state path:

`LOCAL ─────●───── SERVER`

When synchronized:

`LOCAL ─────────── SERVER`

When pending:

`LOCAL ──●●●────── SERVER`

When offline:

`LOCAL ──●●●   ×   SERVER`

This should not literally appear everywhere, but the idea can shape:

- sync indicators
- activity views
- inspector visuals
- onboarding
- connection states

---

## 12. Sync Status

The top-right workspace status is one of the most important controls.

States:

### Synced

`● SYNCED`

### Syncing

`◐ SYNCING · 3`

### Offline

`○ OFFLINE · 7 PENDING`

### Conflict

`! CONFLICT · 1`

Do not use a giant toast every time state changes.

The status should remain visible and calm.

Clicking it opens the Sync Inspector.

---

## 13. Sync Inspector

The Sync Inspector is a signature screen.

It should feel like a compact technical ledger.

Show:

### Connection

`ONLINE`

### Local version

`191`

### Server version

`184`

### Pending operations

`7`

### Last sync

`14:32:18`

Below that, show recent operations:

`14:31:55   UPDATE_ITEM_TITLE`

`14:31:48   MOVE_ITEM`

`14:31:39   CREATE_ITEM`

Each row may display:

- operation type
- entity
- local/server state
- retry count
- acknowledgement state

Use monospace sparingly here.

---

## 14. Offline State

Offline mode should not look like an error screen.

The product still works.

Top status:

`○ OFFLINE`

Supporting text:

`Changes will sync when connection returns.`

Work items continue to be editable.

Pending changes receive small visual marks.

Example:

`◐ pending`

or a tiny amber vertical tick.

Do not dim or disable the whole interface.

Offline is a supported product state, not a failure state.

---

## 15. Reconnection

When connectivity returns:

`○ OFFLINE · 7 PENDING`

becomes:

`◐ SYNCING · 7`

Then counts down or updates:

`◐ SYNCING · 3`

Then:

`● SYNCED`

The animation should be restrained.

A thin progress line is preferable to a spinner.

---

## 16. Conflicts

Conflicts should feel serious but understandable.

Avoid alarming full-screen red dialogs unless absolutely necessary.

A conflict indicator can appear on the affected item:

`! Title changed remotely`

Open a focused conflict panel.

Show:

### Your version

`Launch marketing site`

### Remote version

`Launch campaign site`

Actions:

`Keep mine`

`Use remote`

If a safe merge exists, offer:

`Merge`

The system should explain what changed.

Never silently discard one side.

---

## 17. Presence

Presence should feel human but quiet.

Avoid a row of large circular avatars.

Use:

- small initials
- tiny presence dots
- subtle colored underlines
- collaborator names in margins

Example:

`Mina editing`

next to an item title.

Or:

`AK`

in the lane margin.

Presence should never overpower the work itself.

---

## 18. Navigation

Use a narrow left rail.

Possible sections:

Relay mark

Workspaces

Recent

Invites

---

Account

Keep the workspace surface dominant.

Do not use a giant 280px SaaS sidebar unless the product truly needs it.

---

## 19. Workspace Header

The header may contain:

Workspace name

Member count

Sync status

Invite action

View controls

Avoid giant headings.

The workspace itself is the main object.

---

## 20. Item Detail Panel

Selecting an item opens a right-side detail panel rather than navigating away.

The panel may include:

- title
- description
- stage
- assignee
- comments
- activity
- sync metadata

Keep technical sync metadata hidden behind a disclosure unless relevant.

Normal users should not need to understand distributed systems to use the product.

---

## 21. Empty Workspace

Do not show a generic illustration.

Use the workspace itself.

Example:

`IDEA`

`────────────────`

`Start with one item`

`[ + Add item ]`

A faint state path can run through the empty lanes.

The empty workspace should feel ready, not abandoned.

---

## 22. Landing Page

The landing page should demonstrate the offline-first idea immediately.

Suggested hero:

# Keep working, even when the network disappears.

Supporting text:

Relay is a collaborative workspace that keeps your changes local, syncs when connectivity returns, and makes shared state understandable.

Primary action:

`Open demo`

Secondary:

`Create workspace`

The hero visual should show the same workspace in two states:

Left:

`OFFLINE · 4 PENDING`

Right:

`SYNCED`

with the same items converging.

This is much more meaningful than generic screenshots.

---

## 23. Motion

Motion should explain synchronization.

Good motion:

- operation added to pending queue
- item moving between stages
- pending count decreasing
- reconnect state changing
- remote edit arriving
- conflict marker appearing

Bad motion:

- floating shapes
- constant pulsing
- bouncing buttons
- decorative gradients
- exaggerated page transitions

If motion does not explain state, remove it.

---

## 24. Border Radius

Use restrained rounding.

Controls:

4–6px

Panels:

6–8px

Do not use large 16–24px rounded cards everywhere.

---

## 25. Borders and Shadows

Use borders, spacing, and hierarchy before shadows.

Shadows should be reserved for:

- dragged items
- dialogs
- floating detail panels

Most of the workspace should remain flat and document-like.

---

## 26. Loading States

Prefer structural skeletons that resemble:

- lanes
- item rows
- activity rows

Avoid giant central spinners.

For synchronization:

`Syncing...`

should refer to actual sync work, not generic page loading.

---

## 27. Accessibility

Never rely on color alone for:

- synced
- offline
- conflict
- pending

Use symbols and text.

Examples:

`● SYNCED`

`○ OFFLINE`

`! CONFLICT`

Keyboard users must be able to:

- navigate items
- move between lanes
- open details
- resolve conflicts
- access the Sync Inspector

Drag-and-drop must have a keyboard alternative.

---

## 28. Mobile

On mobile, do not try to show five workflow lanes side by side.

Use one stage at a time.

Possible pattern:

Stage selector at top

`IDEA  PLANNED  BUILDING  REVIEW  SHIPPED`

Then show items for the selected stage.

Item details can become a full-screen sheet.

Sync state must remain visible.

Offline editing should work identically.

---

## 29. Design Anti-Patterns

Do not add:

- dashboard metric cards
- meaningless charts
- giant avatar groups
- glass panels
- purple gradients
- sticky-note rainbow colors
- huge kanban cards
- celebratory confetti
- excessive toasts
- overdesigned empty states

Relay's personality comes from shared-state behavior and the State Ledger visual language.

---

## 30. Signature Product Moments

### Go Offline

The app remains fully usable.

The status changes to:

`○ OFFLINE · 1 PENDING`

### Keep Working

Each local mutation receives a subtle pending mark.

### Reconnect

Pending operations visibly synchronize.

### Remote Update

Another person's change appears without stealing focus.

### Conflict

Relay explains exactly what changed and asks for a deliberate resolution.

### Sync Inspector

A technically curious user can inspect the relationship between local and server state.

These moments matter more than decorative polish.

---

## 31. Product Personality

Relay should communicate:

**Your work continues, even when the connection does not.**

The interface should feel:

- calm
- reliable
- collaborative
- precise
- transparent
- resilient

It should not feel like:

- a toy kanban app
- a generic enterprise dashboard
- a hacker console

---

## 32. Design Decision Rule

Whenever choosing between two UI approaches, ask:

**Does this make shared state easier to understand without making the user think about infrastructure?**

If yes, consider it.

If it only makes the interface look more fashionable, reject it.
