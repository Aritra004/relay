import "server-only";
import { boundTransaction } from "../db/transaction-limits";
import { createHash } from "node:crypto";
import { and, asc, eq, inArray, lt, lte } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "../db/client";
import { operationReceipts, operations, workspaces } from "../db/schema";
import type { SubmittedOperation } from "../../lib/operation-contract";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => [key, canonical(child)]));
  return value;
}
export function operationFingerprint(op: SubmittedOperation, authorId: string) {
  return createHash("sha256").update(JSON.stringify(canonical({ ...op, timestamp: new Date(op.timestamp).toISOString(), authorId }))).digest("hex");
}

// Retain BOTH 30 days and at least the latest 1,000 revisions. One bounded batch
// per workspace per run. Receipts outlive history for arbitrarily stale retries.
export async function pruneWorkspaceOperations(workspaceId: string, { now = new Date(), keepVersions = 1000, retentionDays = 30, batchSize = 500 }: { now?: Date; keepVersions?: number; retentionDays?: number; batchSize?: number } = {}, db: Database | Transaction = getDb()) {
  if (!Number.isInteger(keepVersions) || keepVersions < 1 || !Number.isInteger(retentionDays) || retentionDays < 1 || !Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500 || !Number.isFinite(now.getTime())) throw new Error("Invalid retention policy.");
  return db.transaction(async (tx) => {
    await boundTransaction(tx);
    // Same lock as ingestion: snapshot state is already durable at this version.
    const [workspace] = await tx.select({ version: workspaces.version }).from(workspaces).where(eq(workspaces.id, workspaceId)).for("update");
    if (!workspace) return 0;
    const rows = await tx.select().from(operations).where(and(eq(operations.workspaceId, workspaceId), lte(operations.serverVersion, workspace.version - keepVersions), lt(operations.acceptedAt, new Date(now.getTime() - retentionDays * 86_400_000))))
      .orderBy(asc(operations.serverVersion)).limit(batchSize);
    if (!rows.length) return 0;
    await tx.insert(operationReceipts).values(rows.map((row) => ({
      id: row.id, workspaceId, authorId: row.authorId, entityId: row.entityId, type: row.type, serverVersion: row.serverVersion, entityVersion: row.entityVersion,
      fingerprint: operationFingerprint({ id: row.id, workspaceId, entityId: row.entityId, type: row.type, payload: row.payload, baseVersion: row.baseVersion, timestamp: row.createdAt.toISOString() } as SubmittedOperation, row.authorId),
    })));
    await tx.delete(operations).where(inArray(operations.id, rows.map((row) => row.id)));
    return rows.length;
  });
}
