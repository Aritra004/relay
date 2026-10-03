import "server-only";
import { boundTransaction } from "../db/transaction-limits";
import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, gt, sql } from "drizzle-orm";
import {
  conflictingFields,
  intentValues,
  entityValues,
  type ConflictEntity,
  type ConflictField,
} from "../../lib/conflict-contract";
import {
  operationSchema,
  type SubmittedOperation,
  type OperationAcknowledgment,
} from "../../lib/operation-contract";
import { getDb, type Database, type Transaction } from "../db/client";
import {
  operations,
  workspaces,
  workspaceMembers,
  workflowStages,
  workItems,
  operationReceipts,
} from "../db/schema";
import { operationFingerprint } from "./retention";
import { ApiError } from "../http/errors";
import { assertWorkspacePermission } from "../workspaces/permissions";
import { parseWorkspaceId } from "../workspaces/validation";

export function parseOperation(
  input: unknown,
  workspaceId: string,
): SubmittedOperation {
  const parsed = operationSchema.safeParse(input);
  if (!parsed.success)
    throw new ApiError(
      400,
      "INVALID_OPERATION",
      parsed.error.issues[0]?.message ?? "Invalid operation.",
    );
  if (parsed.data.workspaceId !== workspaceId)
    throw new ApiError(
      400,
      "WORKSPACE_MISMATCH",
      "The operation must target the requested workspace.",
    );
  if (parsed.data.type === "UPDATE_ITEM" && parsed.data.payload.title !== undefined && !parsed.data.payload.title.trim())
    throw new ApiError(400, "INVALID_OPERATION", "Item titles cannot be empty.");
  return parsed.data;
}

type Accepted = typeof operations.$inferSelect;
function acknowledgment(row: Pick<Accepted, "id" | "workspaceId" | "entityId" | "serverVersion" | "entityVersion">): OperationAcknowledgment {
  return {
    operationId: row.id,
    workspaceId: row.workspaceId,
    entityId: row.entityId,
    status: "accepted",
    serverVersion: row.serverVersion,
    entityVersion: row.entityVersion,
  };
}
function duplicate(row: Accepted, op: SubmittedOperation, userId: string) {
  if (
    row.workspaceId !== op.workspaceId ||
    row.authorId !== userId ||
    row.entityId !== op.entityId ||
    row.type !== op.type ||
    row.baseVersion !== op.baseVersion ||
    row.createdAt.getTime() !== Date.parse(op.timestamp) ||
    !isDeepStrictEqual(row.payload, op.payload)
  ) {
    throw new ApiError(
      409,
      "OPERATION_ID_REUSED",
      "This operation ID has already been used for a different operation.",
    );
  }
  return acknowledgment(row);
}
function rejectConflict(
  op: SubmittedOperation,
  entity: ConflictEntity | null,
  entityVersion: number,
  workspaceVersion: number,
  fields: ConflictField[],
) {
  throw new ApiError(
    409,
    "FIELD_CONFLICT",
    "This change needs your decision. Your work is preserved.",
    {
      operation: op,
      entityId: op.entityId,
      entityType: op.type === "RENAME_STAGE" ? "stage" : "item",
      fields,
      clientValues: intentValues(op),
      serverValues: entityValues(entity),
      serverEntity: entity,
      serverEntityVersion: entityVersion,
      serverWorkspaceVersion: workspaceVersion,
    },
  );
}
async function checkConcurrent(
  tx: Transaction,
  op: Exclude<SubmittedOperation, { type: "CREATE_ITEM" }>,
  entity: ConflictEntity,
  workspaceVersion: number,
) {
  if (
    op.baseVersion > entity.version ||
    (op.type !== "RENAME_STAGE" && op.baseVersion < 1)
  )
    throw new ApiError(
      400,
      "INVALID_BASE_VERSION",
      "The operation does not reference an existing entity version.",
    );
  if (op.baseVersion === entity.version) return;
  const history = await tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.workspaceId, op.workspaceId),
        eq(operations.entityId, op.entityId),
        eq(
          operations.entityType,
          op.type === "RENAME_STAGE" ? "stage" : "item",
        ),
        gt(operations.entityVersion, op.baseVersion),
      ),
    )
    .orderBy(asc(operations.entityVersion))
    .limit(1001);
  // Bounded evidence: a missing revision is not permission to overwrite intent.
  if (
    history.length > 1000 ||
    history.length !== entity.version - op.baseVersion ||
    history.some((row, i) => row.entityVersion !== op.baseVersion + i + 1)
  )
    rejectConflict(op, entity, entity.version, workspaceVersion, ["history"]);
  const fields = [
    ...new Set(
      history.flatMap((row) =>
        conflictingFields(
          operationSchema.parse({
            id: row.id,
            workspaceId: row.workspaceId,
            entityId: row.entityId,
            type: row.type,
            payload: row.payload,
            baseVersion: row.baseVersion,
            timestamp: row.createdAt.toISOString(),
          }),
          op,
        ),
      ),
    ),
  ];
  if (fields.length)
    rejectConflict(op, entity, entity.version, workspaceVersion, fields);
}
const itemTarget = (op: SubmittedOperation) =>
  and(eq(workItems.workspaceId, op.workspaceId), eq(workItems.id, op.entityId));
const stageTarget = (workspaceId: string, id: string) =>
  and(eq(workflowStages.workspaceId, workspaceId), eq(workflowStages.id, id));
async function requireStage(tx: Transaction, workspaceId: string, id: string) {
  const [stage] = await tx
    .select({ id: workflowStages.id })
    .from(workflowStages)
    .where(stageTarget(workspaceId, id));
  if (!stage)
    throw new ApiError(
      400,
      "INVALID_STAGE",
      "The destination stage does not belong to this workspace.",
    );
}

// Integer positions describe order, not entity revisions. Shifting surrounding
// positions preserves their relative order and does not edit those entities.
async function destinationPosition(
  tx: Transaction,
  op: Extract<SubmittedOperation, { type: "CREATE_ITEM" | "MOVE_ITEM" }>,
) {
  await requireStage(tx, op.workspaceId, op.payload.stageId);
  const stageItems = and(
    eq(workItems.workspaceId, op.workspaceId),
    eq(workItems.stageId, op.payload.stageId),
  );
  if (op.type === "MOVE_ITEM" && op.payload.beforeItemId !== null) {
    if (op.payload.beforeItemId === op.entityId)
      throw new ApiError(
        400,
        "INVALID_NEIGHBOR",
        "An item cannot move before itself.",
      );
    const [neighbor] = await tx
      .select({ position: workItems.position })
      .from(workItems)
      .where(and(stageItems, eq(workItems.id, op.payload.beforeItemId)));
    if (!neighbor)
      throw new ApiError(
        400,
        "INVALID_NEIGHBOR",
        "The destination neighbor is not in this stage.",
      );
    await tx
      .update(workItems)
      .set({ position: sql`${workItems.position} + 1` })
      .where(
        and(stageItems, sql`${workItems.position} >= ${neighbor.position}`),
      );
    return neighbor.position;
  }
  const [last] = await tx
    .select({ position: sql<number>`coalesce(max(${workItems.position}), -1)` })
    .from(workItems)
    .where(stageItems);
  return last.position + 1;
}

async function apply(
  tx: Transaction,
  op: SubmittedOperation,
  userId: string,
  workspaceVersion: number,
): Promise<number> {
  if (op.type === "CREATE_ITEM") {
    // A deleted ID must not be resurrected under a different create operation.
    const [past] = await tx
      .select({ id: operations.id })
      .from(operations)
      .where(
        and(
          eq(operations.workspaceId, op.workspaceId),
          eq(operations.entityId, op.entityId),
          eq(operations.type, "CREATE_ITEM"),
        ),
      )
      .limit(1);
    const [archivedCreate] = await tx.select({ id: operationReceipts.id }).from(operationReceipts).where(and(eq(operationReceipts.workspaceId, op.workspaceId), eq(operationReceipts.entityId, op.entityId), eq(operationReceipts.type, "CREATE_ITEM"))).limit(1);
    if (past || archivedCreate)
      throw new ApiError(
        400,
        "ENTITY_EXISTS",
        "This item ID has already been used.",
      );
    const position = await destinationPosition(tx, op);
    const [created] = await tx
      .insert(workItems)
      .values({
        id: op.entityId,
        workspaceId: op.workspaceId,
        ...op.payload,
        position,
        version: 1,
        createdBy: userId,
      })
      .onConflictDoNothing({ target: workItems.id })
      .returning({ id: workItems.id });
    if (!created)
      throw new ApiError(
        400,
        "ENTITY_EXISTS",
        "This item ID has already been used.",
      );
    return 1;
  }
  if (op.type === "RENAME_STAGE") {
    const [stage] = await tx
      .select({
        id: workflowStages.id,
        name: workflowStages.name,
        version: workflowStages.version,
      })
      .from(workflowStages)
      .where(stageTarget(op.workspaceId, op.entityId))
      .for("update");
    if (!stage)
      throw new ApiError(
        400,
        "ENTITY_NOT_FOUND",
        "The stage does not belong to this workspace.",
      );
    await checkConcurrent(tx, op, stage, workspaceVersion);
    await tx
      .update(workflowStages)
      .set({
        name: op.payload.name,
        version: stage.version + 1,
        updatedAt: new Date(),
      })
      .where(stageTarget(op.workspaceId, op.entityId));
    return stage.version + 1;
  }
  const [item] = await tx
    .select({
      id: workItems.id,
      title: workItems.title,
      description: workItems.description,
      stageId: workItems.stageId,
      version: workItems.version,
    })
    .from(workItems)
    .where(itemTarget(op))
    .for("update");
  if (!item) {
    const [recentTombstone] = await tx
      .select({ version: operations.entityVersion })
      .from(operations)
      .where(
        and(
          eq(operations.workspaceId, op.workspaceId),
          eq(operations.entityId, op.entityId),
          eq(operations.type, "DELETE_ITEM"),
        ),
      )
      .orderBy(desc(operations.entityVersion))
      .limit(1);
    const [archivedTombstone] = recentTombstone ? [] : await tx.select({ version: operationReceipts.entityVersion }).from(operationReceipts).where(and(eq(operationReceipts.workspaceId, op.workspaceId), eq(operationReceipts.entityId, op.entityId), eq(operationReceipts.type, "DELETE_ITEM"))).orderBy(desc(operationReceipts.entityVersion)).limit(1);
    const tombstone = recentTombstone ?? archivedTombstone;
    if (tombstone && op.baseVersion <= tombstone.version) {
      if (op.type === "DELETE_ITEM") return tombstone.version + 1;
      rejectConflict(op, null, tombstone.version, workspaceVersion, ["delete"]);
    }
    throw new ApiError(
      400,
      "ENTITY_NOT_FOUND",
      "The item does not belong to this workspace.",
    );
  }
  await checkConcurrent(tx, op, item, workspaceVersion);
  const version = item.version + 1;
  switch (op.type) {
    case "UPDATE_ITEM":
      await tx
        .update(workItems)
        .set({ ...op.payload, version, updatedAt: new Date() })
        .where(itemTarget(op));
      break;
    case "DELETE_ITEM":
      await tx.delete(workItems).where(itemTarget(op));
      break;
    case "MOVE_ITEM": {
      if (op.payload.beforeItemId && op.payload.beforeItemId !== op.entityId) {
        const [anchor] = await tx.select({ stageId: workItems.stageId }).from(workItems)
          .where(and(eq(workItems.workspaceId, op.workspaceId), eq(workItems.id, op.payload.beforeItemId)));
        if (anchor?.stageId !== op.payload.stageId) {
          const [pastAnchor] = await tx.select({ id: operations.id }).from(operations)
            .where(and(eq(operations.workspaceId, op.workspaceId), eq(operations.entityId, op.payload.beforeItemId),
              sql`${operations.type} in ('MOVE_ITEM', 'DELETE_ITEM')`)).limit(1);
          if (pastAnchor) rejectConflict(op, item, item.version, workspaceVersion, ["reference"]);
        }
      }
      const position = await destinationPosition(tx, op);
      await tx
        .update(workItems)
        .set({
          stageId: op.payload.stageId,
          position,
          version,
          updatedAt: new Date(),
        })
        .where(itemTarget(op));
      break;
    }
  }
  return version;
}

// All ingestors take the workspace row lock BEFORE checking entity versions.
// READ COMMITTED sees the prior writer's committed state after waiting for it.
// The PK and (workspace_id, server_version) unique constraint are the final guards.
export async function acceptOperation(
  userId: string,
  workspaceId: string,
  input: unknown,
  db: Database | Transaction = getDb(),
) {
  parseWorkspaceId(workspaceId);
  return db.transaction(
    async (tx) => {
      await boundTransaction(tx);
      const [workspace] = await tx
        .select({ version: workspaces.version })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId))
        .for("update");
      const [member] = await tx
        .select({ role: workspaceMembers.role })
        .from(workspaceMembers)
        .where(
          and(
            eq(workspaceMembers.workspaceId, workspaceId),
            eq(workspaceMembers.userId, userId),
          ),
        )
        .for("share");
      assertWorkspacePermission(member?.role, "edit");
      if (!workspace)
        throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      const op = parseOperation(input, workspaceId);
      // Serializes duplicate IDs even when malicious requests target different workspaces.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${op.id}, 0))`,
      );
      const [accepted] = await tx
        .select()
        .from(operations)
        .where(eq(operations.id, op.id));
      if (accepted) return duplicate(accepted, op, userId);
      const [receipt] = await tx.select().from(operationReceipts).where(eq(operationReceipts.id, op.id));
      if (receipt) {
        if (receipt.fingerprint !== operationFingerprint(op, userId))
          throw new ApiError(409, "OPERATION_ID_REUSED", "This operation ID has already been used for a different operation.");
        return acknowledgment(receipt);
      }
      if (workspace.version >= Number.MAX_SAFE_INTEGER)
        throw new ApiError(
          409,
          "VERSION_EXHAUSTED",
          "Workspace version limit reached.",
        );
      const entityVersion = await apply(tx, op, userId, workspace.version);
      const [updated] = await tx
        .update(workspaces)
        .set({ version: sql`${workspaces.version} + 1`, updatedAt: new Date() })
        .where(eq(workspaces.id, workspaceId))
        .returning({ version: workspaces.version });
      const [row] = await tx
        .insert(operations)
        .values({
          id: op.id,
          workspaceId,
          entityId: op.entityId,
          entityType: op.type === "RENAME_STAGE" ? "stage" : "item",
          type: op.type,
          payload: op.payload,
          baseVersion: op.baseVersion,
          authorId: userId,
          serverVersion: updated.version,
          entityVersion,
          createdAt: new Date(op.timestamp),
        })
        .returning();
      return acknowledgment(row);
    },
    { isolationLevel: "read committed" },
  );
}

// Internal bounded history primitive; callers must authorize access.
export function readAcceptedOperations(
  tx: Database | Transaction,
  workspaceId: string,
  afterVersion: number,
  limit = 100,
) {
  return tx
    .select()
    .from(operations)
    .where(
      and(
        eq(operations.workspaceId, workspaceId),
        gt(operations.serverVersion, afterVersion),
      ),
    )
    .orderBy(asc(operations.serverVersion))
    .limit(Math.min(Math.max(limit, 1), 1000));
}
