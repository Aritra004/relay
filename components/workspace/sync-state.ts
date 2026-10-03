import type { WorkspaceState } from "./workspace-store";
import { syncPhaseLabels, type SyncPhase } from "../../lib/sync-contract.ts";

export type SyncStatusState =
  | { status: "synced" }
  | { status: "local" }
  | { status: "saving"; pendingCount: number }
  | { status: "storage-error" }
  | { status: "offline"; pendingCount?: number }
  | { status: "syncing"; pendingCount: number; phase?: SyncPhase }
  | { status: "conflict"; conflictCount?: number }
  | {
      status: "failed";
      reason?: "authorization" | "validation" | "temporary";
      retryAt?: string | null;
    }
  | { status: "pending"; pendingCount: number };

export function selectSyncState(state: WorkspaceState): SyncStatusState {
  const pendingCount = state.pendingOperations.length;
  if (state.storageError) return { status: "storage-error" };
  if (state.unsavedOperationCount > 0)
    return { status: "saving", pendingCount: state.unsavedOperationCount };
  if (state.syncStatus === "offline")
    return { status: "offline", pendingCount };
  if (state.workspace.source === "server") {
    if (state.syncMetadata.syncConflict || state.syncPhase === "conflict")
      return {
        status: "conflict",
        conflictCount: state.syncMetadata.conflicts?.filter(
          (c) => c.status === "unresolved",
        ).length,
      };
    if (
      ["checking", "pulling", "applying-remote", "pushing-local"].includes(
        state.syncPhase,
      )
    )
      return { status: "syncing", pendingCount, phase: state.syncPhase };
    if (state.syncMetadata.uploadFailure || state.syncPhase === "error")
      return {
        status: "failed",
        reason:
          state.syncMetadata.uploadFailure?.kind === "conflict"
            ? undefined
            : state.syncMetadata.uploadFailure?.kind,
        retryAt: state.syncMetadata.uploadFailure?.retryAt,
      };
    if (pendingCount === 0 && state.syncPhase === "synced")
      return { status: "synced" };
    return { status: "syncing", pendingCount, phase: "idle" };
  }
  return pendingCount === 0
    ? { status: "local" }
    : { status: "pending", pendingCount };
}

export function getSyncStatusLabel(state: SyncStatusState): string {
  switch (state.status) {
    case "local":
      return "Saved locally";
    case "saving":
      return `Saving ${state.pendingCount} ${state.pendingCount === 1 ? "change" : "changes"} locally...`;
    case "storage-error":
      return "Local storage error - Not saved";
    case "synced":
      return "Synced with server";
    case "offline": {
      const count = state.pendingCount ?? 0;
      return count > 0
        ? `Offline · ${count} ${count === 1 ? "change" : "changes"} pending`
        : "Offline";
    }
    case "syncing":
      if (state.phase) return syncPhaseLabels[state.phase];
      return `Uploading ${state.pendingCount} ${state.pendingCount === 1 ? "change" : "changes"}...`;
    case "conflict":
      return state.conflictCount
        ? `${state.conflictCount} unresolved ${state.conflictCount === 1 ? "conflict" : "conflicts"}`
        : "Conflict needs attention";
    case "failed":
      if (state.reason === "authorization")
        return "Sign in again · Local changes preserved";
      if (state.reason === "temporary")
        return state.retryAt
          ? "Connection interrupted · Retrying safely"
          : "Sync paused · Retry when connected";
      if (state.reason === "validation")
        return "Change needs attention · Open Sync Inspector";
      return "Sync needs attention";
    case "pending":
      return `${state.pendingCount} ${state.pendingCount === 1 ? "change" : "changes"} pending`;
  }
}
