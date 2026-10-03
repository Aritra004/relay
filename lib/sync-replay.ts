import type { Operation } from "../components/workspace/workspace-operations.ts";
import { applyOperationData } from "../components/workspace/apply-workspace-operation.ts";
import type { WorkspaceSnapshot } from "./workspace-repository.ts";
import type { RemoteOperation } from "./sync-contract.ts";
import { conflictingFields } from "./conflict-contract.ts";
import {
  OperationUploadError,
  submittedOperation,
} from "./operation-upload-http.ts";

export function localOperation(remote: RemoteOperation): Operation {
  const op = remote.operation;
  if (op.type === "CREATE_ITEM")
    return {
      ...op,
      payload: {
        ...op.payload,
        version: 1,
        assignee: "Unassigned",
        label: "Product",
      },
    };
  // The HTTP schema already guarantees at least one update field.
  return op as Operation;
}

export function sameOperation(
  local: Operation,
  remote: RemoteOperation,
  accountId: string,
) {
  const op = submittedOperation(local),
    accepted = remote.operation;
  return (
    remote.authorId === accountId &&
    op.id === accepted.id &&
    op.workspaceId === accepted.workspaceId &&
    op.entityId === accepted.entityId &&
    op.type === accepted.type &&
    op.baseVersion === accepted.baseVersion &&
    Date.parse(op.timestamp) === Date.parse(accepted.timestamp) &&
    JSON.stringify(
      op.payload,
      op.payload ? Object.keys(op.payload).sort() : undefined,
    ) ===
      JSON.stringify(
        accepted.payload,
        accepted.payload ? Object.keys(accepted.payload).sort() : undefined,
      )
  );
}

// Conservative, field-aware classification. Order anchors are dependencies too.
export function classifyRemoteOperation(
  remote: Operation,
  pending: Operation,
): "safe" | "conflict" {
  return conflictingFields(remote, pending).length ? "conflict" : "safe";
}

export function canReplay(state: WorkspaceSnapshot, op: Operation) {
  if (op.workspaceId !== state.workspace.id) return false;
  if (op.type === "CREATE_ITEM")
    return !state.items[op.entityId] && !!state.stages[op.payload.stageId];
  if (op.type === "RENAME_STAGE") return !!state.stages[op.entityId];
  if (op.type === "DELETE_ITEM") return true;
  if (!state.items[op.entityId]) return false;
  if (op.type === "MOVE_ITEM")
    return (
      !!state.stages[op.payload.stageId] &&
      op.payload.beforeItemId !== op.entityId &&
      (op.payload.beforeItemId === null ||
        state.items[op.payload.beforeItemId]?.stageId === op.payload.stageId)
    );
  return true;
}

export function replayPending(
  base: WorkspaceSnapshot,
  pending: readonly Operation[],
): WorkspaceSnapshot {
  let visible = base;
  for (const operation of pending) {
    if (!canReplay(visible, operation))
      throw new OperationUploadError(
        "conflict",
        "PENDING_REFERENCE_CHANGED",
        "A pending change references an item or stage that changed remotely. Your work is preserved.",
      );
    visible = applyOperationData(visible, operation);
  }
  return { ...visible, pendingOperations: pending };
}

export function applyRemote(
  base: WorkspaceSnapshot,
  remote: RemoteOperation,
): WorkspaceSnapshot {
  const op = localOperation(remote);
  const version =
    op.type === "RENAME_STAGE"
      ? base.stages[op.entityId]?.version
      : base.items[op.entityId]?.version;
  if (
    !canReplay(base, op) ||
    (op.type !== "CREATE_ITEM" &&
      version !== undefined &&
      (op.baseVersion! > version || remote.entityVersion !== version + 1)) ||
    (op.type === "CREATE_ITEM"
      ? remote.entityVersion !== 1
      : remote.entityVersion <= op.baseVersion!)
  )
    throw new OperationUploadError(
      "validation",
      "INVALID_REMOTE_OPERATION",
      "The remote operation cannot be replayed at the confirmed version.",
    );
  const applied = applyOperationData(base, op);
  if (op.type === "RENAME_STAGE")
    return {
      ...applied,
      stages: {
        ...applied.stages,
        [op.entityId]: {
          ...applied.stages[op.entityId],
          version: remote.entityVersion,
        },
      },
    };
  if (op.type === "DELETE_ITEM") return applied;
  return {
    ...applied,
    items: {
      ...applied.items,
      [op.entityId]: {
        ...applied.items[op.entityId],
        version: remote.entityVersion,
        changed: false,
        updated: op.timestamp,
      },
    },
  };
}
