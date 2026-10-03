import { requireUser } from "@/server/auth/session";
import { ApiError } from "@/server/http/errors";
import { apiResponse, assertSameOrigin, json, readJson } from "@/server/http/response";
import { updatePresence } from "@/server/presence/service";

export const runtime = "nodejs";
async function handle(request: Request, context: { params: Promise<{ workspaceId: string }> }, leave: boolean) {
  return apiResponse(async () => {
    assertSameOrigin(request);
    const user = await requireUser();
    if (request.headers.get("x-relay-account-id") !== user.id)
      throw new ApiError(403, "ACCOUNT_CHANGED", "Sign in to the account that owns this workspace.");
    const { workspaceId } = await context.params;
    return json(await updatePresence(user.id, workspaceId, await readJson(request), leave));
  });
}
export const POST = (request: Request, context: { params: Promise<{ workspaceId: string }> }) => handle(request, context, false);
export const DELETE = (request: Request, context: { params: Promise<{ workspaceId: string }> }) => handle(request, context, true);
