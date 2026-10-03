import { loadEnvConfig } from "@next/env";
import { asc, gt } from "drizzle-orm";
import { getDb } from "../server/db/client";
import { workspaces } from "../server/db/schema";
import { pruneWorkspaceOperations } from "../server/operations/retention";

loadEnvConfig(process.cwd());
const db = getDb();
let cursor: string | undefined;
let removed = 0;
for (;;) {
  const page = await db.select({ id: workspaces.id }).from(workspaces).where(cursor ? gt(workspaces.id, cursor) : undefined).orderBy(asc(workspaces.id)).limit(50);
  if (!page.length) break;
  for (const workspace of page) removed += await pruneWorkspaceOperations(workspace.id);
  cursor = page.at(-1)!.id;
}
console.info(`Compacted ${removed} old operations; idempotency receipts retained.`);
process.exit(0);
