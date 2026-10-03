import type { SyncStatusState } from "./sync-state";
import type { Operation } from "./workspace-operations";
import type { WorkspaceState } from "./workspace-store";
import { syncPhaseLabels } from "../../lib/sync-contract.ts";

// Isolated development indicator fixture; never used by the live inspector.
export const defaultSyncPreview = {
  status: "pending",
  pendingCount: 7,
} as const satisfies SyncStatusState;

type ActivityState = "pending" | "confirmed" | "sending" | "failed" | "local";

interface SyncActivity {
  id: string;
  timestamp: string;
  time: string;
  label: string;
  detail: string;
  state: ActivityState;
}

interface SyncSnapshot {
  connection: string;
  localVersion: number;
  serverVersion: number | null;
  currentServerVersion: number | null;
  receivedRemoteOperations: number;
  phase: string;
  persistedLocalRevision: number;
  unsavedCount: number;
  pendingCount: number;
  lastSync: string | null;
  lastSnapshot: string | null;
  summary: string;
  uploadProgress: string;
  activity: SyncActivity[];
}

function describeOperation(
  operation: Operation,
  state: WorkspaceState,
): Pick<SyncActivity, "label" | "detail"> {
  const item = state.items[operation.entityId];
  const itemName = item
    ? item.title.trim() || "Untitled item"
    : `Item ${operation.entityId}`;
  switch (operation.type) {
    case "CREATE_ITEM":
      return { label: "Created item", detail: operation.payload.title };
    case "UPDATE_ITEM": {
      const fields = [
        operation.payload.title !== undefined ? "title" : null,
        operation.payload.description !== undefined ? "description" : null,
      ].filter(Boolean).join(" and ");
      return {
        label: `Updated item ${fields}`,
        detail: operation.payload.title !== undefined
          ? operation.payload.title.trim() || "Untitled item"
          : itemName,
      };
    }
    case "DELETE_ITEM":
      return { label: "Deleted item", detail: itemName };
    case "MOVE_ITEM":
      return {
        label: `Moved item to ${state.stages[operation.payload.stageId]?.name ?? operation.payload.stageId}`,
        detail: itemName,
      };
    case "RENAME_STAGE":
      return { label: "Renamed stage", detail: operation.payload.name };
  }
}

export function getSyncSnapshot(state: WorkspaceState): SyncSnapshot {
  const pendingCount = state.pendingOperations.length;
  const server = state.workspace.source === "server";
  const failure = state.syncMetadata.uploadFailure;
  return {
    connection: state.syncStatus === "offline" ? "Offline" : server ? "Online" : "Local only",
    phase: syncPhaseLabels[state.syncPhase],
    localVersion: state.syncMetadata.localRevision,
    persistedLocalRevision: state.persistedLocalRevision,
    unsavedCount: state.unsavedOperationCount,
    serverVersion: state.syncMetadata.confirmedServerVersion ?? null,
    currentServerVersion: state.syncMetadata.currentServerVersion ?? null,
    receivedRemoteOperations: (state.syncMetadata.receivedRemoteOperations ?? 0) + (state.syncMetadata.syncConflict?.remoteOperation ? 1 : 0),
    pendingCount,
    lastSync: state.syncMetadata.lastSyncedAt,
    lastSnapshot: state.syncMetadata.lastSnapshotAt ?? null,
    uploadProgress: server ? `${state.uploadedCount} accepted this visit · ${pendingCount} remaining${state.uploadingOperationId ? " · 1 in flight" : ""}` : "Not connected",
    summary: state.storageError ?? (state.unsavedOperationCount > 0
      ? "Saving changes to this device. Keep this tab open until saving finishes."
      : failure ? `${failure.message} ${failure.retryAt ? `Retry scheduled for ${failure.retryAt}.` : "The queue is paused; later changes are preserved."}`
      : server ? state.syncStatus === "offline" ? "Changes stay on this device until connectivity returns."
        : state.syncPhase === "synced" ? "All local changes are uploaded and all known server changes are applied."
        : `${syncPhaseLabels[state.syncPhase]}. Pending local work stays on this device.`
      : pendingCount > 0
      ? "Changes are saved on this device and queued. Sync is not connected yet."
      : "No pending changes. Sync is not connected yet."),
    // Bound rendering work. The complete durable queue remains exportable.
    activity: [...state.pendingOperations.slice(-100).reverse().map((operation): SyncActivity => ({
      id: operation.id,
      timestamp: operation.timestamp,
      time: `${operation.timestamp.slice(11, 19)} UTC`,
      ...describeOperation(operation, state),
      ...(failure?.operationId === operation.id ? { detail: `${failure.code}: ${failure.message} (attempt ${failure.attempts})` } : {}),
      state: state.uploadingOperationId === operation.id ? "sending" : failure?.operationId === operation.id ? "failed" : "pending",
    })), ...(state.syncMetadata.recentAcknowledgments ?? []).map((ack): SyncActivity => ({
      id: ack.operationId, timestamp: ack.acknowledgedAt, time: `${ack.acknowledgedAt.slice(11, 19)} UTC`,
      label: ack.type.replaceAll("_", " "), detail: `Server v${ack.serverVersion} · entity v${ack.entityVersion} · ${ack.entityId}`,
      state: "confirmed",
    })), ...(state.syncMetadata.recentRemoteOperations ?? []).map((remote): SyncActivity => ({
      id: remote.operation.id, timestamp: remote.operation.timestamp,
      time: `${remote.operation.timestamp.slice(11, 19)} UTC`,
      label: `Received ${remote.operation.type.replaceAll("_", " ").toLowerCase()}`,
      detail: `Server v${remote.serverVersion} · ${remote.operation.entityId}`, state: "confirmed",
    }))],
  };
}
