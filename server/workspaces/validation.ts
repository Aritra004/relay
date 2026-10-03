import { z } from "zod";
import { ApiError } from "../http/errors";

const createWorkspaceInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
});

export function parseWorkspaceInput(value: unknown) {
  const result = createWorkspaceInput.safeParse(value);
  if (!result.success)
    throw new ApiError(
      400,
      "INVALID_INPUT",
      "Provide a workspace name between 1 and 120 characters, with no additional fields.",
    );
  return result.data;
}

export function parseWorkspaceId(value: string) {
  if (!z.uuid().safeParse(value).success)
    throw new ApiError(400, "INVALID_INPUT", "Invalid workspace ID.");
  return value;
}
