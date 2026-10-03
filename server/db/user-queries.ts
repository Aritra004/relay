import "server-only";
import { getDb } from "./client";
import { users } from "./schema";

export async function provisionUser(identity: { id: string; email: string; name: string }) {
  const [user] = await getDb().insert(users).values({
    authProvider: "neon", authUserId: identity.id, email: identity.email, name: identity.name,
  }).onConflictDoUpdate({
    target: [users.authProvider, users.authUserId],
    set: { email: identity.email, name: identity.name, updatedAt: new Date() },
  }).returning();
  return user;
}
