import { z } from "zod";
import {
  operationSchema,
  type SubmittedOperation,
} from "./operation-contract.ts";
import type { Operation } from "../components/workspace/workspace-operations.ts";
import type { WorkItem } from "../components/workspace/workspace-data.ts";

export const conflictFieldSchema = z.enum([
  "title",
  "description",
  "move",
  "delete",
  "name",
  "identity",
  "reference",
  "history",
]);
export type ConflictField = z.infer<typeof conflictFieldSchema>;
export const conflictEntitySchema = z.union([
  z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    stageId: z.string(),
    version: z.number().int().nonnegative(),
  }),
  z.object({
    id: z.string(),
    name: z.string(),
    version: z.number().int().nonnegative(),
  }),
]);
export type ConflictEntity = z.infer<typeof conflictEntitySchema>;
export const conflictContextSchema = z.object({
  operation: operationSchema,
  entityId: z.string(),
  entityType: z.enum(["item", "stage"]),
  fields: z.array(conflictFieldSchema).min(1),
  clientValues: z.record(z.string(), z.string().nullable()),
  serverValues: z.record(z.string(), z.string().nullable()),
  serverEntity: conflictEntitySchema.nullable(),
  serverEntityVersion: z.number().int().nonnegative(),
  serverWorkspaceVersion: z.number().int().nonnegative(),
});
export type ConflictContext = z.infer<typeof conflictContextSchema>;
export interface ConflictRecord extends ConflictContext {
  id: string;
  operationId: string;
  detectedAt: string;
  status: "unresolved" | "resolved";
  resolvedAt?: string;
  resolution?: "mine" | "server";
  replacementOperationId?: string;
  localItem?: WorkItem;
}

type Intent = Operation | SubmittedOperation;
// Compare intent, not entity counters. See server/operations/CONFLICTS.md.
export function conflictingFields(
  remote: Intent,
  local: Intent,
): ConflictField[] {
  if (remote.workspaceId !== local.workspaceId) return [];
  if (
    local.type === "MOVE_ITEM" &&
    local.payload.beforeItemId === remote.entityId &&
    (remote.type === "DELETE_ITEM" || remote.type === "MOVE_ITEM")
  )
    return ["reference"];
  if (
    remote.entityId !== local.entityId ||
    (remote.type === "RENAME_STAGE") !== (local.type === "RENAME_STAGE")
  )
    return [];
  if (remote.type === "CREATE_ITEM" || local.type === "CREATE_ITEM")
    return ["identity"];
  if (remote.type === "DELETE_ITEM" && local.type === "DELETE_ITEM") return [];
  if (remote.type === "DELETE_ITEM" || local.type === "DELETE_ITEM")
    return ["delete"];
  if (remote.type === "RENAME_STAGE" && local.type === "RENAME_STAGE")
    return ["name"];
  if (remote.type === "MOVE_ITEM" && local.type === "MOVE_ITEM")
    return ["move"];
  if (remote.type === "UPDATE_ITEM" && local.type === "UPDATE_ITEM")
    return (["title", "description"] as const).filter(
      (field) =>
        remote.payload[field] !== undefined &&
        local.payload[field] !== undefined,
    );
  return [];
}

export function intentValues(op: Intent): Record<string, string | null> {
  switch (op.type) {
    case "UPDATE_ITEM":
      return { ...op.payload };
    case "MOVE_ITEM":
      return {
        move: op.payload.stageId,
        beforeItemId: op.payload.beforeItemId,
      };
    case "DELETE_ITEM":
      return { delete: "Deleted" };
    case "RENAME_STAGE":
      return { name: op.payload.name };
    case "CREATE_ITEM":
      return {
        title: op.payload.title,
        description: op.payload.description,
        move: op.payload.stageId,
      };
  }
}
export function entityValues(
  entity: ConflictEntity | null,
): Record<string, string | null> {
  if (!entity) return { delete: "Deleted" };
  return "name" in entity
    ? { name: entity.name }
    : {
        title: entity.title,
        description: entity.description,
        move: entity.stageId,
        delete: "Keep item",
      };
}
export function unresolvedConflicts(metadata: {
  conflicts?: readonly ConflictRecord[];
}) {
  return (metadata.conflicts ?? []).filter(
    (conflict) => conflict.status === "unresolved",
  );
}
export function operationBlocked(
  op: Operation,
  conflicts: readonly ConflictRecord[],
) {
  return conflicts.some(
    (c) =>
      c.status === "unresolved" &&
      ((c.entityId === op.entityId &&
        (c.entityType === "stage") === (op.type === "RENAME_STAGE")) ||
        (c.entityType === "item" &&
          op.type === "MOVE_ITEM" &&
          op.payload.beforeItemId === c.entityId)),
  );
}
export function nextUpload(
  pending: readonly Operation[],
  conflicts: readonly ConflictRecord[],
) {
  const blocked = new Set<string>();
  return pending.find((op) => {
    if (
      operationBlocked(op, conflicts) ||
      blocked.has(op.entityId) ||
      (op.type === "MOVE_ITEM" &&
        op.payload.beforeItemId !== null &&
        blocked.has(op.payload.beforeItemId))
    ) {
      blocked.add(op.entityId);
      return false;
    }
    return true;
  });
}
