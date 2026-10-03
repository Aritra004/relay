import {
  historySchema,
  remoteOperationSchema,
  type OperationHistory,
} from "./sync-contract.ts";
import { z } from "zod";
import { acknowledgmentSchema } from "./operation-contract.ts";
import { OperationUploadError } from "./operation-upload-http.ts";
import { toLocalSnapshot } from "./server-snapshot.ts";

export async function fetchOperationReceipt(
  workspaceId: string,
  operationId: string,
  accountId: string,
  signal: AbortSignal,
) {
  const input = await syncGet(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/operations?operationId=${encodeURIComponent(operationId)}`,
    accountId,
    signal,
  );
  const result = z
    .strictObject({ accepted: remoteOperationSchema.nullable(), archived: acknowledgmentSchema.optional() })
    .safeParse(input);
  if (!result.success)
    throw new OperationUploadError(
      "temporary",
      "INVALID_RECEIPT",
      "Unable to verify an operation receipt.",
    );
  return result.data.archived ? { archived: result.data.archived } : result.data.accepted;
}

export async function syncGet(
  path: string,
  accountId: string,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(path, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "X-Relay-Account-ID": accountId },
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok)
    throw new OperationUploadError(
      response.status >= 500 || [408, 429].includes(response.status)
        ? "temporary"
        : [401, 403, 404].includes(response.status)
          ? "authorization"
          : "validation",
      typeof data?.error?.code === "string"
        ? data.error.code
        : `HTTP_${response.status}`,
      typeof data?.error?.message === "string"
        ? data.error.message
        : "Unable to synchronize this workspace.",
    );
  return data;
}

export function validateHistory(
  input: unknown,
  workspaceId: string,
  afterVersion: number,
): OperationHistory {
  const parsed = historySchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.workspaceId !== workspaceId ||
    parsed.data.currentWorkspaceVersion < afterVersion
  )
    throw new OperationUploadError(
      "temporary",
      "INVALID_HISTORY",
      "The server returned invalid operation history. Local data is preserved.",
    );
  const page = parsed.data;
  if (
    page.status === "ok" &&
    (page.startingVersion !== afterVersion ||
      page.endingVersion !== afterVersion + page.operations.length ||
      page.endingVersion > page.currentWorkspaceVersion ||
      page.hasMore !== page.endingVersion < page.currentWorkspaceVersion ||
      (page.hasMore && !page.operations.length) ||
      page.operations.some(
        (op, i) =>
          op.serverVersion !== afterVersion + i + 1 ||
          op.operation.workspaceId !== workspaceId,
      ))
  )
    throw new OperationUploadError(
      "temporary",
      "INVALID_HISTORY",
      "The server returned unordered or incomplete operation history.",
    );
  return page;
}

export async function fetchOperationHistory(
  workspaceId: string,
  afterVersion: number,
  accountId: string,
  signal: AbortSignal,
) {
  return validateHistory(
    await syncGet(
      `/api/workspaces/${encodeURIComponent(workspaceId)}/operations?afterVersion=${afterVersion}&limit=100`,
      accountId,
      signal,
    ),
    workspaceId,
    afterVersion,
  );
}
export async function fetchSyncSnapshot(
  workspaceId: string,
  accountId: string,
  signal: AbortSignal,
) {
  return toLocalSnapshot(
    await syncGet(
      `/api/workspaces/${encodeURIComponent(workspaceId)}`,
      accountId,
      signal,
    ),
    workspaceId,
    accountId,
  );
}
