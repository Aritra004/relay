import "server-only";
import { auth } from "./auth";
import { provisionUser } from "../db/user-queries";
import { ApiError } from "../http/errors";

export async function requireUser() {
  // Verify with the provider on each private request, including revoked sessions.
  const { data: session, error } = await auth.getSession({ query: { disableCookieCache: "true" } });
  if (error) throw new ApiError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable. Please try again.");
  if (!session?.user) throw new ApiError(401, "UNAUTHENTICATED", "Sign in to access online workspaces.");
  return provisionUser(session.user);
}
