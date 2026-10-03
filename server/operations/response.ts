import "server-only";
import { ApiError } from "../http/errors";
import { json } from "../http/response";
import type { OperationFailureKind } from "../../lib/operation-contract";

export async function operationResponse(
  action: () => Promise<Response>,
  operationId: () => string | null,
) {
  try {
    return await action();
  } catch (error) {
    const known = error instanceof ApiError;
    const status = known ? error.status : 503;
    const kind: OperationFailureKind =
      status >= 500 || status === 429
        ? "temporary"
        : [401, 403, 404].includes(status)
          ? "authorization"
          : status === 409
            ? "conflict"
            : "validation";
    if (!known)
      console.error("Operation submission failed", {
        type: error instanceof Error ? error.name : "UnknownError",
      });
    return json(
      {
        operationId: operationId(),
        status: "rejected",
        ...(known && error.conflict ? { conflict: error.conflict } : {}),
        error: {
          kind,
          code: known ? error.code : "SERVER_UNAVAILABLE",
          message: known
            ? error.message
            : "The operation could not be completed. Retry with the same ID.",
          retryable: kind === "temporary",
        },
      },
      status,
    );
  }
}
