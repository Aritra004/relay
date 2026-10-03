import "server-only";
import { createNeonAuth } from "@neondatabase/auth/next/server";
import { requireEnv } from "../env";

export const auth = createNeonAuth({
  baseUrl: requireEnv("NEON_AUTH_BASE_URL"),
  cookies: { secret: requireEnv("NEON_AUTH_COOKIE_SECRET") },
});
