import type { ConflictContext } from "../../lib/conflict-contract";

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly conflict?: ConflictContext,
  ) {
    super(message);
    this.name = "ApiError";
  }
}
