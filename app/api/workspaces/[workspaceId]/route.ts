import { requireUser } from "@/server/auth/session";
import { apiResponse, json } from "@/server/http/response";
import { getWorkspaceSnapshot } from "@/server/workspaces/service";
import { ApiError } from "@/server/http/errors";

export const runtime = "nodejs";
export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return apiResponse(async () => {
    const user = await requireUser();
    const expectedAccount = request.headers.get("x-relay-account-id");
    if (expectedAccount && expectedAccount !== user.id)
      throw new ApiError(
        403,
        "ACCOUNT_CHANGED",
        "Sign in to the account that owns this workspace.",
      );
    const { workspaceId } = await context.params;
    return json(await getWorkspaceSnapshot(user.id, workspaceId));
  });
}
