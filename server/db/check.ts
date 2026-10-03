import { loadEnvConfig } from "@next/env";
import { sql } from "drizzle-orm";
import { getDb } from "./client";

loadEnvConfig(process.cwd());
async function main() {
  const result = await getDb().execute(sql`select 1 as connected`);
  if (result.rows[0]?.connected !== 1) throw new Error("Unexpected query result.");
  console.log("Neon connection verified: SELECT 1 succeeded through the server database client.");
}
main().catch(() => {
  console.error("Database check failed. Verify the server DATABASE_URL and network connection.");
  process.exitCode = 1;
});
