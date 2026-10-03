import "server-only";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { requireEnv } from "../env";
import * as schema from "./schema";
import { databaseConnectionUrl } from "./connection";

const globalDb = globalThis as typeof globalThis & { relayPool?: Pool };

export function getDb() {
  // Lazy initialization keeps the public offline shell independent of Neon.
  if (!globalDb.relayPool) {
    globalDb.relayPool = new Pool({
      connectionString: databaseConnectionUrl(requireEnv("DATABASE_URL")),
      max: 5,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      // Bound lock waits and release abandoned transactions after a network
      // interruption. Clients retain operation IDs and safely retry failures.
      statement_timeout: 15_000,
      idle_in_transaction_session_timeout: 30_000,
      allowExitOnIdle: true,
    });
    globalDb.relayPool.on("connect", (client) => {
      // A socket can close between awaited statements while a transaction owns
      // the client. pg otherwise emits an unhandled error before the next query
      // can reject. Pending queries still reject and transactions roll back.
      client.on("error", () => console.error("A database connection was interrupted."));
    });
    globalDb.relayPool.on("error", () => console.error("An idle database connection failed."));
  }
  return drizzle(globalDb.relayPool, { schema });
}

export type Database = ReturnType<typeof getDb>;
export type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
