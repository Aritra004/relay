import type { Operation } from "../components/workspace/workspace-operations.ts";
import { applyOperationData } from "../components/workspace/apply-workspace-operation.ts";
import type { WorkspaceSnapshot } from "./workspace-repository.ts";
import type { WorkspaceSyncMetadata } from "./local-db.ts";
import { canReplay } from "./sync-replay.ts";
import { submittedOperation } from "./operation-upload-http.ts";
import {
  entityValues,
  intentValues,
  type ConflictContext,
  type ConflictField,
  type ConflictRecord,
} from "./conflict-contract.ts";

export function currentValues(base: WorkspaceSnapshot, entityId: string, entityType: "item" | "stage") {
  const entity = entityType === "stage" ? base.stages[entityId] : base.items[entityId];
  const values = entityValues((entity ?? null) as ConflictContext["serverEntity"]);
  if (entity && "stageId" in entity) {
    const order = base.itemOrderByStage[entity.stageId] ?? [];
    values.beforeItemId = order[order.indexOf(entity.id) + 1] ?? null;
  }
  return values;
}

export function conflictContext(
  op: Operation,
  base: WorkspaceSnapshot,
  version: number,
  fields: ConflictField[],
  entityVersion?: number,
): ConflictContext {
  const entity =
    (op.type === "RENAME_STAGE"
      ? base.stages[op.entityId]
      : base.items[op.entityId]) ?? null;
  return {
    operation: submittedOperation(op),
    entityId: op.entityId,
    entityType: op.type === "RENAME_STAGE" ? "stage" : "item",
    fields,
    clientValues: intentValues(op),
    serverValues: currentValues(base, op.entityId, op.type === "RENAME_STAGE" ? "stage" : "item"),
    serverEntity: entity as ConflictContext["serverEntity"],
    serverEntityVersion:
      entityVersion ?? entity?.version ?? op.baseVersion ?? 0,
    serverWorkspaceVersion: version,
  };
}

export function recordConflict(
  records: readonly ConflictRecord[],
  context: ConflictContext,
  visible: WorkspaceSnapshot,
): ConflictRecord[] {
  const existing = records.find(
    (c) =>
      c.status === "unresolved" &&
      c.entityId === context.entityId &&
      c.entityType === context.entityType,
  );
  let localItem = visible.items[context.entityId] ?? existing?.localItem;
  if (!localItem && context.serverEntity && "title" in context.serverEntity) {
    localItem = { ...context.serverEntity, assignee: "Unassigned", label: "Product", updated: "Just now" };
    for (const op of visible.pendingOperations) if (op.entityId === context.entityId) {
      if (op.type === "UPDATE_ITEM") localItem = { ...localItem, ...op.payload };
      if (op.type === "MOVE_ITEM") localItem = { ...localItem, stageId: op.payload.stageId };
    }
  }
  const clientValues = { ...existing?.clientValues, ...context.clientValues };
  if (localItem) {
    if (context.fields.includes("title") || existing?.fields.includes("title"))
      clientValues.title = localItem.title;
    if (
      context.fields.includes("description") ||
      existing?.fields.includes("description")
    )
      clientValues.description = localItem.description;
    if (context.fields.includes("move") || existing?.fields.includes("move"))
      clientValues.move = localItem.stageId;
  }
  const next: ConflictRecord = {
    ...context,
    id: existing?.id ?? crypto.randomUUID(),
    operation: existing?.operation ?? context.operation,
    operationId: existing?.operationId ?? context.operation.id,
    detectedAt: existing?.detectedAt ?? new Date().toISOString(),
    status: "unresolved",
    fields: [...new Set([...(existing?.fields ?? []), ...context.fields])],
    clientValues,
    ...(localItem ? { localItem } : {}),
  };
  return [...records.filter((c) => c.id !== next.id), next];
}

export function withConflicts(
  metadata: WorkspaceSyncMetadata,
  conflicts: readonly ConflictRecord[],
): WorkspaceSyncMetadata {
  const unresolved = conflicts.filter((c) => c.status === "unresolved");
  return {
    ...metadata,
    conflicts: [
      ...unresolved,
      ...conflicts.filter((c) => c.status === "resolved").slice(-20),
    ],
    // Retain the old presence flag for existing caches/status consumers.
    syncConflict: unresolved[0]
      ? {
          operationId: unresolved[0].operationId,
          reason:
            "Choose which version to keep. Unrelated work can still sync.",
        }
      : null,
    uploadFailure:
      metadata.uploadFailure?.kind === "conflict"
        ? null
        : metadata.uploadFailure,
  };
}

// Local intents stay visible even when their server target was deleted. This is
// a projection only; the confirmed base never contains these preserved items.
export function projectPending(
  base: WorkspaceSnapshot,
  pending: readonly Operation[],
  before: WorkspaceSnapshot,
  conflicts: readonly ConflictRecord[],
): WorkspaceSnapshot {
  let visible = base;
  for (const op of pending) {
    // Keep a discoverable card for deletion-versus-edit decisions as well.
    if (op.type === "DELETE_ITEM" && conflicts.some((c) => c.status === "unresolved" && c.entityId === op.entityId)) continue;
    if (
      !visible.items[op.entityId] &&
      ["UPDATE_ITEM", "MOVE_ITEM"].includes(op.type)
    ) {
      const item =
        before.items[op.entityId] ??
        conflicts.find(
          (c) => c.status === "unresolved" && c.entityId === op.entityId,
        )?.localItem;
      if (item && visible.stages[item.stageId])
        visible = {
          ...visible,
          items: { ...visible.items, [item.id]: item },
          itemOrderByStage: {
            ...visible.itemOrderByStage,
            [item.stageId]: [
              ...visible.itemOrderByStage[item.stageId],
              item.id,
            ],
          },
        };
    }
    if (canReplay(visible, op)) visible = applyOperationData(visible, op);
    else if (
      op.type === "MOVE_ITEM" &&
      visible.items[op.entityId] &&
      visible.stages[op.payload.stageId]
    )
      visible = applyOperationData(visible, {
        ...op,
        payload: { ...op.payload, beforeItemId: null },
      });
    // Unreplayable intent remains durable in the queue and its conflict record.
  }
  return { ...visible, pendingOperations: pending };
}

export function resolutionOperations(
  conflict: ConflictRecord,
  choice: "mine" | "server",
  base: WorkspaceSnapshot,
  visible: WorkspaceSnapshot,
  pending: readonly Operation[],
) {
  const sameEntity = (op: Operation) =>
    op.entityId === conflict.entityId &&
    (op.type === "RENAME_STAGE") === (conflict.entityType === "stage");
  const related = pending.filter(sameEntity);
  const entity =
    conflict.entityType === "stage"
      ? base.stages[conflict.entityId]
      : base.items[conflict.entityId];
  const newMetadata = (entityId = conflict.entityId) => ({
    id: crypto.randomUUID(),
    entityId,
    workspaceId: base.workspace.id,
    timestamp: new Date().toISOString(),
  });
  const replacements: Operation[] = [];
  let restoredId: string | undefined;
  if (!entity && conflict.entityType === "item") {
    if (choice === "mine") {
      const item = visible.items[conflict.entityId] ?? conflict.localItem;
      if (!item)
        throw new Error(
          "The preserved item is unavailable. Keep this conflict for recovery.",
        );
      restoredId = crypto.randomUUID();
      replacements.push({
        ...newMetadata(restoredId),
        type: "CREATE_ITEM",
        baseVersion: null,
        payload: {
          title: item.title.trim() || "Untitled item",
          description: item.description,
          stageId: item.stageId,
          assignee: item.assignee,
          label: item.label,
          version: 1,
        },
      });
    }
  } else {
    const dropping = new Set(choice === "server" ? conflict.fields : []);
    const dropAll = dropping.has("history") || dropping.has("identity");
    let title: string | undefined, description: string | undefined;
    let move: Extract<Operation, { type: "MOVE_ITEM" }> | undefined;
    let rename: Extract<Operation, { type: "RENAME_STAGE" }> | undefined;
    let deletion = false;
    if (!dropAll)
      for (const op of related) {
        if (op.type === "UPDATE_ITEM") {
          if (!dropping.has("title") && op.payload.title !== undefined)
            title = op.payload.title;
          if (
            !dropping.has("description") &&
            op.payload.description !== undefined
          )
            description = op.payload.description;
        }
        if (
          op.type === "MOVE_ITEM" &&
          !dropping.has("move") &&
          !dropping.has("reference")
        )
          move = op;
        if (op.type === "RENAME_STAGE" && !dropping.has("name")) rename = op;
        if (op.type === "DELETE_ITEM" && !dropping.has("delete"))
          deletion = true;
      }
    const baseVersion = entity?.version ?? conflict.serverEntityVersion;
    if (deletion)
      replacements.push({
        ...newMetadata(),
        type: "DELETE_ITEM",
        baseVersion,
        payload: null,
      });
    else {
      if (title !== undefined || description !== undefined)
        replacements.push({
          ...newMetadata(),
          type: "UPDATE_ITEM",
          baseVersion,
          payload: {
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
          },
        } as Operation);
      if (move)
        replacements.push({
          ...move,
          ...newMetadata(),
          baseVersion,
          payload: {
            ...move.payload,
            beforeItemId:
              move.payload.beforeItemId &&
              base.items[move.payload.beforeItemId]?.stageId ===
                move.payload.stageId
                ? move.payload.beforeItemId
                : null,
          },
        });
      if (rename)
        replacements.push({ ...rename, ...newMetadata(), baseVersion });
    }
  }
  let inserted = false;
  const next: Operation[] = [];
  for (const op of pending) {
    if (sameEntity(op)) {
      if (!inserted) {
        next.push(...replacements);
        inserted = true;
      }
    } else if (
      op.type === "MOVE_ITEM" &&
      op.payload.beforeItemId === conflict.entityId &&
      !entity
    ) {
      // Keep a dependent move after the restoring create, with a fresh identity.
      if (!inserted) {
        next.push(...replacements);
        inserted = true;
      }
      next.push({
        ...op,
        ...newMetadata(op.entityId),
        payload: { ...op.payload, beforeItemId: restoredId ?? null },
      });
    } else next.push(op);
  }
  return { pending: next, replacements };
}
