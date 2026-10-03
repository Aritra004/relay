import "server-only";

export function requireEnv(name: "DATABASE_URL" | "NEON_AUTH_BASE_URL" | "NEON_AUTH_COOKIE_SECRET") {
  const value = process.env[name];
  if (!value) throw new Error(`Missing server environment variable: ${name}`);
  return value;
}
