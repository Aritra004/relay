import "server-only";
import { boundTransaction } from "../db/transaction-limits";
import { getDb, type Database, type Transaction } from "../db/client";
import {
  findMembership,
  insertWorkspace,
  listUserWorkspaces,
  readWorkspaceSnapshot,
} from "../db/workspace-queries";
import {
  assertWorkspacePermission,
  type WorkspacePermission,
} from "./permissions";
import { parseWorkspaceId, parseWorkspaceInput } from "./validation";

export const defaultStages = [
  { name: "IDEA", description: "A place for possibilities" },
  { name: "PLANNED", description: "Ready for the next step" },
  { name: "BUILDING", description: "Work taking shape" },
  { name: "REVIEW", description: "A fresh pair of eyes" },
  { name: "SHIPPED", description: "Out in the world" },
] as const;

// userId must come from the verified session, never the request body.
// Pass a transaction for future mutations so authorization and writes stay atomic.
export async function requireWorkspacePermission(
  db: Database | Transaction,
  userId: string,
  workspaceId: string,
  permission: WorkspacePermission,
) {
  const membership = await findMembership(
    db,
    parseWorkspaceId(workspaceId),
    userId,
  );
  assertWorkspacePermission(membership?.role, permission);
  return membership!;
}

export async function createWorkspace(
  userId: string,
  input: unknown,
  db: Database | Transaction = getDb(),
) {
  const { name } = parseWorkspaceInput(input);
  return db.transaction(async (tx) => {
    await boundTransaction(tx);
    const workspace = await insertWorkspace(tx, userId, name, defaultStages);
    return {
      workspace,
      membership: { workspaceId: workspace.id, userId, role: "owner" as const },
    };
  });
}

export async function listWorkspaces(
  userId: string,
  db: Database | Transaction = getDb(),
) {
  return listUserWorkspaces(db, userId);
}

export async function getWorkspaceSnapshot(
  userId: string,
  workspaceId: string,
  db: Database | Transaction = getDb(),
) {
  // Membership, metadata, stages and items all come from the same MVCC snapshot.
  return db.transaction(
    async (tx) => {
      await boundTransaction(tx);
      const membership = await requireWorkspacePermission(
        tx,
        userId,
        workspaceId,
        "read",
      );
      const snapshot = await readWorkspaceSnapshot(tx, workspaceId);
      return {
        ...snapshot,
        version: snapshot.workspace.version,
        membership,
        stageOrder: snapshot.stages.map((stage) => stage.id),
        itemOrderByStage: Object.fromEntries(
          snapshot.stages.map((stage) => [
            stage.id,
            snapshot.items
              .filter((item) => item.stageId === stage.id)
              .map((item) => item.id),
          ]),
        ),
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
}
