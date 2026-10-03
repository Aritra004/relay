import { ApiError } from "../http/errors";

export type WorkspaceRole = "owner" | "member";
export type WorkspacePermission = "read" | "edit" | "manage";

export function assertWorkspacePermission(
  role: WorkspaceRole | undefined,
  permission: WorkspacePermission,
) {
  // Missing and inaccessible workspaces have the same response to avoid ID probing.
  if (!role)
    throw new ApiError(404, "WORKSPACE_NOT_FOUND", "Workspace not found.");
  if (permission === "manage" && role !== "owner") {
    throw new ApiError(
      403,
      "FORBIDDEN",
      "Only workspace owners can manage the workspace and its members.",
    );
  }
}
