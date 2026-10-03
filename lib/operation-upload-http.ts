import type { Operation } from "../components/workspace/workspace-operations.ts";
import {
  conflictContextSchema,
  type ConflictContext,
} from "./conflict-contract.ts";
import {
  acknowledgmentSchema,
  operationSchema,
  type OperationAcknowledgment,
  type OperationFailureKind,
} from "./operation-contract.ts";

export class OperationUploadError extends Error {
  readonly kind: OperationFailureKind;
  readonly code: string;
  readonly conflict?: ConflictContext;
  constructor(
    kind: OperationFailureKind,
    code: string,
    message: string,
    conflict?: ConflictContext,
  ) {
    super(message);
    this.kind = kind;
    this.code = code;
    this.conflict = conflict;
  }
}

export function submittedOperation(operation: Operation) {
  // The existing queue includes local presentation defaults on CREATE_ITEM.
  // Project only domain fields; in particular payload.version is never authority.
  const payload =
    operation.type === "CREATE_ITEM"
      ? {
          title: operation.payload.title,
          description: operation.payload.description,
          stageId: operation.payload.stageId,
        }
      : operation.payload;
  const result = operationSchema.safeParse({ ...operation, payload });
  if (!result.success)
    throw new OperationUploadError(
      "validation",
      "INVALID_LOCAL_OPERATION",
      operation.type === "RENAME_STAGE" && operation.baseVersion === null
        ? "This saved rename has no server base version. Preserve it for recovery; automatic upload is paused."
        : `This saved operation is invalid: ${result.error.issues[0]?.message ?? "Invalid fields"}`,
    );
  return result.data;
}

export function validateAcknowledgment(
  input: unknown,
  operation: Operation,
): OperationAcknowledgment {
  const parsed = acknowledgmentSchema.safeParse(input);
  if (
    !parsed.success ||
    parsed.data.operationId !== operation.id ||
    parsed.data.workspaceId !== operation.workspaceId ||
    parsed.data.entityId !== operation.entityId ||
    (operation.type === "CREATE_ITEM"
      ? parsed.data.entityVersion !== 1
      : parsed.data.entityVersion <= (operation.baseVersion ?? -1))
  ) {
    throw new OperationUploadError(
      "temporary",
      "INVALID_ACKNOWLEDGMENT",
      "Invalid server acknowledgment. The operation is retained for retry.",
    );
  }
  return parsed.data;
}

export async function submitOperation(
  operation: Operation,
  accountId: string,
  signal: AbortSignal,
): Promise<OperationAcknowledgment> {
  const body = JSON.stringify(submittedOperation(operation));
  const response = await fetch(
    `/api/workspaces/${encodeURIComponent(operation.workspaceId)}/operations`,
    {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "Content-Type": "application/json",
        "X-Relay-Account-ID": accountId,
      },
      body,
      signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
    },
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const conflict = conflictContextSchema.safeParse(data?.conflict);
    if (
      data?.conflict &&
      (!conflict.success ||
        conflict.data.operation.id !== operation.id ||
        conflict.data.operation.workspaceId !== operation.workspaceId ||
        conflict.data.entityId !== operation.entityId)
    )
      throw new OperationUploadError(
        "temporary",
        "INVALID_CONFLICT",
        "The conflict response could not be verified. Your change is retained.",
      );
    const kind: OperationFailureKind =
      response.status >= 500 || [408, 429].includes(response.status)
        ? "temporary"
        : [401, 403, 404].includes(response.status)
          ? "authorization"
          : response.status === 409
            ? "conflict"
            : "validation";
    throw new OperationUploadError(
      kind,
      typeof data?.error?.code === "string"
        ? data.error.code
        : `HTTP_${response.status}`,
      typeof data?.error?.message === "string"
        ? data.error.message
        : "The server could not accept this operation.",
      conflict.success ? conflict.data : undefined,
    );
  }
  return validateAcknowledgment(data, operation);
}
