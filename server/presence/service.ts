import "server-only";
import { boundTransaction } from "../db/transaction-limits";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { getDb, type Database, type Transaction } from "../db/client";
import { presenceLeases, users, workspaceMembers, workItems } from "../db/schema";
import { requireWorkspacePermission } from "../workspaces/service";
import { ApiError } from "../http/errors";
import { presenceInputSchema, PRESENCE_TTL_MS, type PresenceMember } from "../../lib/presence-contract";

export function summarizePresence(rows: { userId: string; name: string; lastSeen: Date; editingItemId: string | null }[], workspaceId: string, now: number): PresenceMember[] {
  const members = new Map<string, PresenceMember>();
  const editing = new Map<string, { at: number; itemId: string }>();
  for (const row of rows) {
    const at = row.lastSeen.getTime();
    if (row.editingItemId && now - at < 20_000 && at > (editing.get(row.userId)?.at ?? -1))
      editing.set(row.userId, { at, itemId: row.editingItemId });
    const status = now - row.lastSeen.getTime() < PRESENCE_TTL_MS ? "online" : "offline";
    const prior = members.get(row.userId);
    if (prior && Date.parse(prior.lastSeen) >= row.lastSeen.getTime()) continue;
    members.set(row.userId, {
      userId: row.userId, displayName: row.name.slice(0, 200),
      avatar: row.name.trim().split(/\s+/).slice(0, 2).map((s) => Array.from(s)[0]).join("").toUpperCase().slice(0, 4),
      workspaceId, status, lastSeen: row.lastSeen.toISOString(),
      editingItemId: status === "online" && now - row.lastSeen.getTime() < 20_000 ? row.editingItemId : null,
    });
  }
  return [...members.values()].map((member) => ({ ...member, editingItemId: editing.get(member.userId)?.itemId ?? null })).sort((a, b) => a.displayName.localeCompare(b.displayName));
}

export async function updatePresence(userId: string, workspaceId: string, input: unknown, leave = false, db: Database | Transaction = getDb()) {
  const parsed = presenceInputSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, "INVALID_PRESENCE", "Invalid presence heartbeat.");
  return db.transaction(async (tx) => {
    await boundTransaction(tx);
    await requireWorkspacePermission(tx, userId, workspaceId, "read");
    const { clientId, editingItemId } = parsed.data;
    if (editingItemId && !leave) {
      const [item] = await tx.select({ id: workItems.id }).from(workItems).where(and(eq(workItems.id, editingItemId), eq(workItems.workspaceId, workspaceId)));
      // Offline-created items may not be uploaded yet. Never expose another workspace's ID.
      if (!item) parsed.data.editingItemId = null;
    }
    const [{ now }] = await tx.select({ now: sql<Date>`clock_timestamp()` }).from(sql`(select 1) as clock`);
    const serverNow = new Date(now);
    await tx.delete(presenceLeases).where(lt(presenceLeases.lastSeen, new Date(serverNow.getTime() - 2 * PRESENCE_TTL_MS)));
    if (leave) {
      await tx.delete(presenceLeases).where(and(eq(presenceLeases.workspaceId, workspaceId), eq(presenceLeases.userId, userId), eq(presenceLeases.clientId, clientId)));
    } else {
      await tx.insert(presenceLeases).values({ workspaceId, userId, clientId, editingItemId: parsed.data.editingItemId, lastSeen: serverNow }).onConflictDoUpdate({
        target: [presenceLeases.workspaceId, presenceLeases.userId, presenceLeases.clientId],
        set: { lastSeen: serverNow, editingItemId: parsed.data.editingItemId },
      });
    }
    const rows = await tx.select({ userId: users.id, name: users.name, lastSeen: presenceLeases.lastSeen, editingItemId: presenceLeases.editingItemId })
      .from(presenceLeases).innerJoin(users, eq(users.id, presenceLeases.userId))
      .innerJoin(workspaceMembers, and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, users.id)))
      .where(and(eq(presenceLeases.workspaceId, workspaceId), gt(presenceLeases.lastSeen, new Date(serverNow.getTime() - 2 * PRESENCE_TTL_MS))))
      .orderBy(sql`${presenceLeases.lastSeen} desc`).limit(500);
    return { workspaceId, serverTime: serverNow.toISOString(), members: summarizePresence(rows, workspaceId, serverNow.getTime()).slice(0, 200) };
  });
}
