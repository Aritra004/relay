import type { StageId, WorkspaceData } from "./workspace-data";

// A stable neighbor identifies the insertion point even when the board is filtered.
// null means the end of the destination stage.
export type ItemMove = {
  itemId: string;
  stageId: StageId;
  beforeItemId: string | null;
};

export function moveWorkItem<T extends WorkspaceData>(state: T, move: ItemMove): T {
  const item = state.items[move.itemId];
  if (!item || !state.stages[move.stageId] || move.beforeItemId === item.id)
    return state;

  const sameStage = item.stageId === move.stageId;
  const sourceOrder = state.itemOrderByStage[item.stageId];
  const destination = sameStage
    ? sourceOrder.filter((id) => id !== item.id)
    : state.itemOrderByStage[move.stageId];
  const index = move.beforeItemId === null
    ? destination.length
    : destination.indexOf(move.beforeItemId);
  // A stale anchor or a card in a different stage must not change the board.
  if (index < 0) return state;

  const destinationOrder = [...destination];
  destinationOrder.splice(index, 0, item.id);
  if (
    sameStage &&
    destinationOrder.every((id, position) => id === sourceOrder[position])
  )
    return state;

  const itemOrderByStage = {
    ...state.itemOrderByStage,
    [move.stageId]: destinationOrder,
  };
  if (!sameStage) {
    itemOrderByStage[item.stageId] = sourceOrder.filter((id) => id !== item.id);
  }

  // Only the moved entity (including its local-edit metadata) and the affected
  // ID lists change. Stages, stage order, and every other item retain identity.
  return {
    ...state,
    items: {
      ...state.items,
      [item.id]: {
        ...item,
        stageId: move.stageId,
        changed: true,
        updated: "Just now",
      },
    },
    itemOrderByStage,
  };
}
