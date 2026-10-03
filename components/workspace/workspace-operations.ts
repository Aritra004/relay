import type {
  ItemChanges,
  StageId,
  WorkItem,
  WorkflowStage,
} from "./workspace-data";
import type { ItemMove } from "./item-movement";

// A standalone, JSON-serializable description of one meaningful user change.
// Local application lives in apply-workspace-operation.ts; this file is the model.
interface OperationMetadata {
  // A client-generated UUID identifying this change, distinct from the entity ID.
  readonly id: string;
  readonly workspaceId: string;
  readonly entityId: string;
  // The entity version observed before the change, or null if none exists.
  // Recording it does not increment versions or define conflict resolution.
  readonly baseVersion: number | null;
  // Client creation time as a UTC ISO 8601 string (new Date().toISOString()).
  // This is metadata, not an authoritative ordering or conflict-resolution rule.
  readonly timestamp: string;
}

export interface CreateItemOperation extends OperationMetadata {
  readonly type: "CREATE_ITEM";
  readonly baseVersion: null;
  // entityId is the new item's permanent ID. Creation appends to stageId.
  // Include initial domain values, excluding UI-only updated/changed metadata.
  readonly payload: Pick<
    WorkItem,
    "title" | "description" | "stageId" | "assignee" | "label" | "version"
  >;
}

// A change contains at least one editable field; an empty string clears text.
export type UpdateItemPayload = ItemChanges &
  (Pick<WorkItem, "title"> | Pick<WorkItem, "description">);

export interface UpdateItemOperation extends OperationMetadata {
  readonly type: "UPDATE_ITEM";
  readonly baseVersion: number;
  readonly payload: UpdateItemPayload;
}

export interface DeleteItemOperation extends OperationMetadata {
  readonly type: "DELETE_ITEM";
  readonly baseVersion: number;
  // The target is fully identified by entityId; no additional payload is needed.
  readonly payload: null;
}

export interface MoveItemOperation extends OperationMetadata {
  readonly type: "MOVE_ITEM";
  readonly baseVersion: number;
  // Resolve keyboard direction/filters before representing a move. A stable
  // neighbor records the destination; beforeItemId: null means append.
  readonly payload: Readonly<Omit<ItemMove, "itemId">>;
}

export interface RenameStageOperation extends OperationMetadata {
  readonly type: "RENAME_STAGE";
  readonly entityId: StageId;
  // null preserves legacy/demo operations; online renames require a known base.
  readonly baseVersion: number | null;
  readonly payload: Pick<WorkflowStage, "name">;
}

// Narrowing by type selects the matching payload and base-version shape.
export type Operation =
  | CreateItemOperation
  | UpdateItemOperation
  | DeleteItemOperation
  | MoveItemOperation
  | RenameStageOperation;

export type OperationType = Operation["type"];
