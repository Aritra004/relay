import "server-only";
import { boundTransaction } from "../db/transaction-limits";
import { and, eq } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "../db/client";
import { workspaces, operations, operationReceipts } from "../db/schema";
import type { OperationAcknowledgment } from "../../lib/operation-contract";
import { requireWorkspacePermission } from "../workspaces/service";
import { ApiError } from "../http/errors";
import { readAcceptedOperations } from "./service";
import { operationSchema } from "../../lib/operation-contract";
import type {
  OperationHistory,
  RemoteOperation,
} from "../../lib/sync-contract";
import { parseWorkspaceId } from "../workspaces/validation";

export async function getOperationReceipt(
  userId: string,
  workspaceId: string,
  operationId: string,
  db: Database | Transaction = getDb(),
): Promise<{ accepted: RemoteOperation | null; archived?: OperationAcknowledgment }> {
  parseWorkspaceId(operationId);
  return db.transaction(
    async (tx) => {
      await boundTransaction(tx);
      await requireWorkspacePermission(tx, userId, workspaceId, "read");
      const [row] = await tx
        .select()
        .from(operations)
        .where(
          and(
            eq(operations.id, operationId),
            eq(operations.workspaceId, workspaceId),
            eq(operations.authorId, userId),
          ),
        );
      if (!row) {
        const [receipt] = await tx.select().from(operationReceipts).where(and(eq(operationReceipts.id, operationId), eq(operationReceipts.workspaceId, workspaceId), eq(operationReceipts.authorId, userId)));
        if (receipt) return { accepted: null, archived: { operationId, workspaceId, entityId: receipt.entityId, status: "accepted" as const, serverVersion: receipt.serverVersion, entityVersion: receipt.entityVersion } };
      }
      return {
        accepted: row
          ? {
              operation: operationSchema.parse({
                id: row.id,
                workspaceId,
                entityId: row.entityId,
                type: row.type,
                payload: row.payload,
                baseVersion: row.baseVersion,
                timestamp: row.createdAt.toISOString(),
              }),
              authorId: row.authorId,
              serverVersion: row.serverVersion,
              entityVersion: row.entityVersion,
            }
          : null,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}

export function parseHistoryQuery(query: URLSearchParams) {
  const integer = (name: string, fallback: number, max: number) => {
    const value = query.get(name);
    if (
      query.getAll(name).length > 1 ||
      (value !== null && !/^\d+$/.test(value))
    )
      throw new ApiError(400, "INVALID_CURSOR", `Invalid ${name}.`);
    const parsed = value === null ? fallback : Number(value);
    if (
      !Number.isSafeInteger(parsed) ||
      parsed < (name === "limit" ? 1 : 0) ||
      parsed > max
    )
      throw new ApiError(400, "INVALID_CURSOR", `Invalid ${name}.`);
    return parsed;
  };
  return {
    afterVersion: integer("afterVersion", 0, Number.MAX_SAFE_INTEGER),
    limit: integer("limit", 100, 500),
  };
}

export async function getOperationHistory(
  userId: string,
  workspaceId: string,
  afterVersion: number,
  limit = 100,
  db: Database | Transaction = getDb(),
): Promise<OperationHistory> {
  // Authorization, version and log share one MVCC snapshot, including when a
  // writer commits during this request. No cursor can skip an unseen commit.
  return db.transaction(
    async (tx) => {
      await boundTransaction(tx);
      await requireWorkspacePermission(tx, userId, workspaceId, "read");
      const [workspace] = await tx
        .select({ version: workspaces.version })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      if (!workspace)
        throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
      if (
        !Number.isSafeInteger(afterVersion) ||
        afterVersion < 0 ||
        afterVersion > workspace.version ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 500
      )
        throw new ApiError(
          400,
          "INVALID_CURSOR",
          "The history cursor or batch size is invalid.",
        );
      const rows = await readAcceptedOperations(
        tx,
        workspaceId,
        afterVersion,
        limit,
      );
      if (
        rows.some((row, i) => row.serverVersion !== afterVersion + i + 1) ||
        (rows.length < limit &&
          (rows.at(-1)?.serverVersion ?? afterVersion) < workspace.version)
      ) {
        return {
          status: "snapshot-required",
          workspaceId,
          currentWorkspaceVersion: workspace.version,
          reason: "OPERATION_HISTORY_UNAVAILABLE",
        };
      }
      const ordered = rows.map((row) => ({
        operation: operationSchema.parse({
          id: row.id,
          workspaceId,
          entityId: row.entityId,
          type: row.type,
          payload: row.payload,
          baseVersion: row.baseVersion,
          timestamp: row.createdAt.toISOString(),
        }),
        authorId: row.authorId,
        serverVersion: row.serverVersion,
        entityVersion: row.entityVersion,
      }));
      const endingVersion = rows.at(-1)?.serverVersion ?? afterVersion;
      return {
        status: "ok",
        workspaceId,
        startingVersion: afterVersion,
        endingVersion,
        currentWorkspaceVersion: workspace.version,
        operations: ordered,
        hasMore: endingVersion < workspace.version,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
