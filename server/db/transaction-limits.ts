import "server-only";
import { sql } from "drizzle-orm";
import type { Transaction } from "./client";

// Transaction-local settings also work through PgBouncer, which does not
// preserve session/startup settings. Never let an abandoned request hold locks.
export async function boundTransaction(tx: Transaction) {
  await tx.execute(sql`select set_config('statement_timeout', '15000', true), set_config('idle_in_transaction_session_timeout', '30000', true)`);
}
