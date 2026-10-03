import { requireUser } from "@/server/auth/session";
import { ApiError } from "@/server/http/errors";
import { assertSameOrigin, json, readJson } from "@/server/http/response";
import { acceptOperation } from "@/server/operations/service";
import { operationResponse } from "@/server/operations/response";
import { apiResponse } from "@/server/http/response";
import { getOperationHistory, getOperationReceipt, parseHistoryQuery } from "@/server/operations/history";

export const runtime = "nodejs";
export async function GET(request: Request, context: { params: Promise<{ workspaceId: string }> }) {
  return apiResponse(async () => {
    const user = await requireUser();
    const expectedAccount = request.headers.get("x-relay-account-id");
    if (expectedAccount && expectedAccount !== user.id)
      throw new ApiError(403, "ACCOUNT_CHANGED", "Sign in to the account that owns this workspace.");
    const { workspaceId } = await context.params;
    const query = new URL(request.url).searchParams;
    if (query.has("operationId")) return json(await getOperationReceipt(user.id, workspaceId, query.get("operationId")!));
    const { afterVersion, limit } = parseHistoryQuery(query);
    return json(await getOperationHistory(user.id, workspaceId, afterVersion, limit));
  });
}
export async function POST(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  let operationId: string | null = null;
  return operationResponse(
    async () => {
      assertSameOrigin(request);
      const user = await requireUser();
      // An account precondition, never the source of the authenticated author.
      const expectedAccount = request.headers.get("x-relay-account-id");
      if (expectedAccount && expectedAccount !== user.id)
        throw new ApiError(
          403,
          "ACCOUNT_CHANGED",
          "Sign in to the account that owns this local queue.",
        );
      const input = await readJson(request, 128 * 1024);
      if (
        input &&
        typeof input === "object" &&
        "id" in input &&
        typeof input.id === "string"
      )
        operationId = input.id;
      const { workspaceId } = await context.params;
      return json(await acceptOperation(user.id, workspaceId, input));
    },
    () => operationId,
  );
}
