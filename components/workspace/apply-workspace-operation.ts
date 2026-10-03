import { moveWorkItem } from "./item-movement.ts";
import type { WorkItem, WorkspaceData, WorkspaceDetails } from "./workspace-data.ts";
import type { Operation } from "./workspace-operations.ts";
import type { WorkspaceState } from "./workspace-store.ts";

// Pure domain application: the operation already contains its IDs and timestamp.
// No UUIDs, clocks, networking, or version/conflict decisions belong here.
export function applyOperationData<T extends WorkspaceData & { readonly workspace: WorkspaceDetails }>(
  state: T,
  operation: Operation,
): T {
  if (operation.workspaceId !== state.workspace.id) return state;

  let next: T;
  switch (operation.type) {
    case "CREATE_ITEM": {
      const { entityId, payload } = operation;
      const title = payload.title;
      if (
        !title.trim() ||
        Object.hasOwn(state.items, entityId) ||
        !Object.hasOwn(state.stages, payload.stageId)
      ) return state;
      const item: WorkItem = {
        id: entityId,
        title,
        description: payload.description,
        stageId: payload.stageId,
        assignee: payload.assignee,
        label: payload.label,
        version: payload.version,
        updated: "Just now",
        changed: true,
      };
      next = {
        ...state,
        items: { ...state.items, [entityId]: item },
        itemOrderByStage: {
          ...state.itemOrderByStage,
          [item.stageId]: [...state.itemOrderByStage[item.stageId], entityId],
        },
      };
      break;
    }
    case "UPDATE_ITEM": {
      if (!Object.hasOwn(state.items, operation.entityId)) return state;
      const item = state.items[operation.entityId];
      const title = operation.payload.title ?? item.title;
      const description = operation.payload.description ?? item.description;
      if (title === item.title && description === item.description) return state;
      next = {
        ...state,
        items: {
          ...state.items,
          [item.id]: { ...item, title, description, updated: "Just now", changed: true },
        },
      };
      break;
    }
    case "DELETE_ITEM": {
      if (!Object.hasOwn(state.items, operation.entityId)) return state;
      const item = state.items[operation.entityId];
      const items = { ...state.items };
      delete items[item.id];
      next = {
        ...state,
        items,
        itemOrderByStage: {
          ...state.itemOrderByStage,
          [item.stageId]: state.itemOrderByStage[item.stageId].filter(
            (id) => id !== item.id,
          ),
        },
      };
      break;
    }
    case "MOVE_ITEM": {
      if (
        !Object.hasOwn(state.items, operation.entityId) ||
        !Object.hasOwn(state.stages, operation.payload.stageId)
      ) return state;
      next = moveWorkItem(state, {
        itemId: operation.entityId,
        stageId: operation.payload.stageId,
        beforeItemId: operation.payload.beforeItemId,
      });
      if (next === state) return state;
      break;
    }
    case "RENAME_STAGE": {
      if (!Object.hasOwn(state.stages, operation.entityId)) return state;
      const stage = state.stages[operation.entityId];
      const name = operation.payload.name;
      if (!name.trim() || name === stage.name) return state;
      next = {
        ...state,
        stages: { ...state.stages, [stage.id]: { ...stage, name } },
      };
      break;
    }
    default: {
      const unsupported: never = operation;
      throw new Error(`Unsupported workspace operation: ${JSON.stringify(unsupported)}`);
    }
  }

  return next;
}

export function applyWorkspaceOperation(state: WorkspaceState, operation: Operation): WorkspaceState {
  const next = applyOperationData(state, operation);
  if (next === state) return state;
  // Queue bookkeeping is local-only; both origins use applyOperationData.
  return {
    ...next,
    selectedItemId: state.selectedItemId && next.items[state.selectedItemId] ? state.selectedItemId : null,
    lastOperation: operation,
    pendingOperations: [...state.pendingOperations, operation],
  };
}
