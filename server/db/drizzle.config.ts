import { loadEnvConfig } from "@next/env";
import { defineConfig } from "drizzle-kit";
import { databaseConnectionUrl } from "./connection";

loadEnvConfig(process.cwd());
const url = process.env.DATABASE_URL_UNPOOLED;
if (!url) throw new Error("DATABASE_URL_UNPOOLED is required for migrations.");
if (new URL(url).hostname.includes("-pooler"))
  throw new Error("Migrations require a direct database connection.");

export default defineConfig({
  schema: "./server/db/schema/index.ts",
  out: "./server/db/migrations",
  dialect: "postgresql",
  dbCredentials: { url: databaseConnectionUrl(url) },
  strict: true,
});
