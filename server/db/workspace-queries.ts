import "server-only";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Database, Transaction } from "./client";
import { users, workspaces, workspaceMembers, workflowStages, workItems } from "./schema";

type QueryDb = Database | Transaction;

export async function findMembership(db: QueryDb, workspaceId: string, userId: string) {
  const [membership] = await db.select().from(workspaceMembers).where(and(
    eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, userId),
  ));
  return membership;
}

export async function insertWorkspace(tx: Transaction, userId: string, name: string,
  stages: readonly { name: string; description: string }[]) {
  const [workspace] = await tx.insert(workspaces).values({ name, createdBy: userId }).returning();
  await tx.insert(workspaceMembers).values({ workspaceId: workspace.id, userId, role: "owner" });
  await tx.insert(workflowStages).values(stages.map((stage, position) => ({
    ...stage, workspaceId: workspace.id, position,
  })));
  return workspace;
}

export function listUserWorkspaces(db: QueryDb, userId: string) {
  return db.select({ id: workspaces.id, name: workspaces.name, version: workspaces.version,
    createdAt: workspaces.createdAt, updatedAt: workspaces.updatedAt, role: workspaceMembers.role })
    .from(workspaceMembers).innerJoin(workspaces, eq(workspaces.id, workspaceMembers.workspaceId))
    .where(eq(workspaceMembers.userId, userId)).orderBy(desc(workspaces.updatedAt), asc(workspaces.id));
}

export async function readWorkspaceSnapshot(tx: Transaction, workspaceId: string) {
  const [workspace] = await tx.select().from(workspaces).where(eq(workspaces.id, workspaceId));
  const stages = await tx.select().from(workflowStages).where(eq(workflowStages.workspaceId, workspaceId))
    .orderBy(asc(workflowStages.position), asc(workflowStages.id));
  const items = await tx.select().from(workItems).where(eq(workItems.workspaceId, workspaceId))
    .orderBy(asc(workItems.position), asc(workItems.id));
  const members = await tx.select({ userId: workspaceMembers.userId, role: workspaceMembers.role,
    joinedAt: workspaceMembers.joinedAt, name: users.name })
    .from(workspaceMembers).innerJoin(users, eq(users.id, workspaceMembers.userId))
    .where(eq(workspaceMembers.workspaceId, workspaceId)).orderBy(asc(workspaceMembers.joinedAt), asc(users.id));
  return { workspace, stages, items, members };
}
