import { requireUser } from "@/server/auth/session";
import { ApiError } from "@/server/http/errors";
import { apiResponse, assertSameOrigin } from "@/server/http/response";
import {
  getOperationHistory,
  parseHistoryQuery,
} from "@/server/operations/history";
import { operationStream } from "@/server/realtime/stream";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(
  request: Request,
  context: { params: Promise<{ workspaceId: string }> },
) {
  return apiResponse(async () => {
    assertSameOrigin(request);
    const user = await requireUser();
    if (request.headers.get("x-relay-account-id") !== user.id)
      throw new ApiError(
        403,
        "ACCOUNT_CHANGED",
        "Sign in to the account that owns this workspace.",
      );
    const { workspaceId } = await context.params;
    const { afterVersion } = parseHistoryQuery(
      new URL(request.url).searchParams,
    );
    // Every poll rechecks workspace membership. Short stream leases also force a
    // fresh session check, including provider-side revocation, on reconnect.
    const read = (cursor: number) =>
      getOperationHistory(user.id, workspaceId, cursor, 100);
    const initial = await read(afterVersion);
    return operationStream({ initial, read, signal: request.signal });
  });
}
