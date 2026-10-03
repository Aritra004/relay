// Shared by the server pool and migration tooling. Never imported by the UI.
export function databaseConnectionUrl(value: string) {
  const url = new URL(value);
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("Invalid database URL protocol.");
  // Explicitly verify the Neon certificate and hostname across pg upgrades.
  url.searchParams.set("sslmode", "verify-full");
  url.searchParams.delete("uselibpqcompat");
  return url.toString();
}
