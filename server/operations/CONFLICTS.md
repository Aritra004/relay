# Conflict rules

These rules apply to concurrent operations based on the same confirmed state.
An entity/workspace version mismatch alone is never a user conflict. Sequential
operations from one device retain queue order. A duplicate operation ID with the
same request returns its original receipt; reusing it for a different request is
invalid.

## Same item (or same stage for renames)

Every cell is an outcome for the local row and accepted remote column.

| Local / remote | CREATE_ITEM | UPDATE_ITEM | MOVE_ITEM | DELETE_ITEM | RENAME_STAGE |
| --- | --- | --- | --- | --- | --- |
| CREATE_ITEM | Invalid: ID already used | Invalid: ID already used | Invalid: ID already used | Invalid: ID already used | Compatible: separate entity types |
| UPDATE_ITEM | Invalid: item did not exist at base | Conflict for overlapping title/description; compatible for disjoint fields | Compatible | Conflict: edit versus deletion | Compatible |
| MOVE_ITEM | Invalid: item did not exist at base | Compatible | Conflict: destination/order intent | Conflict: move versus deletion | Compatible |
| DELETE_ITEM | Invalid: item did not exist at base | Conflict: deletion versus edit | Conflict: deletion versus move | Compatible: already deleted | Compatible |
| RENAME_STAGE | Compatible | Compatible | Compatible | Compatible | Conflict: name |

An update carries only fields that actually changed in the editor. Two title
edits conflict even when the resulting strings coincide: neither clock nor arrival
order decides intent. Move versus move conflicts include within-stage ordering,
even if both destinations name the same stage. A rename does not affect stage IDs.

## Different entities and references

All 25 operation pairs on unrelated entities are compatible. Exceptions:

| Dependency | Outcome |
| --- | --- |
| Move before an item moved/deleted remotely | Conflict: anchor changed; keep mine appends to the intended stage if the anchor is gone |
| Move/create into a renamed stage | Compatible: stage ID is stable |
| Move before an item whose title/description changed | Compatible |
| Missing/foreign stage, foreign item, self-anchor, nonexistent item without a deletion record, future base version | Invalid |
| Create reuses any previously created item ID | Invalid, including deleted IDs |
| Earlier pending create followed by edit/move/delete of that item | Sequential dependency; upload create first |

## Durable decisions

The confirmed projection and history cursor continue advancing during conflicts.
IndexedDB retains each rejected intent, both values, entity/workspace versions,
first detection time, and local deleted-item contents. Only that entity and moves
depending on its order are paused. The visible board replays local work over the
confirmed projection; a remotely deleted item remains visible as a conflict.

Keep mine creates a new operation ID against the latest confirmed entity version.
Use server removes only the conflicting fields/actions, preserving compatible
fields and later compatible operations. Both decisions commit the queue, board,
and conflict history atomically. Resolution can conflict again with newer changes.

Restore item with local edits creates a new item ID using the preserved local
contents. The deleted identity stays deleted; moves anchored to the restored item
are retargeted. Keep deleted discards edits for that deleted item only.

If operation history is unavailable, the client keeps original base versions and
submits them for server field checks. It never silently rebases uncertain edits.
The server reports unavailable evidence explicitly if it cannot prove a merge.
Recent resolved conflicts are capped at 20; unresolved work is never evicted.
