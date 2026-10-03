import { Icon } from "./icons";
import { getSyncStatusLabel, selectSyncState, type SyncStatusState } from "./sync-state";
import { useWorkspaceSelector } from "./workspace-provider";

const statusIcons = {
  local: "monitor",
  saving: "refresh",
  "storage-error": "alert-circle",
  synced: "check-circle",
  offline: "cloud-off",
  syncing: "refresh",
  failed: "alert-circle",
  conflict: "alert-circle",
  pending: "monitor",
} as const;

export function SyncStatus({ id }: { id?: string }) {
  const snapshot = useWorkspaceSelector((state) => state);
  return <SyncStatusIndicator state={selectSyncState(snapshot)} id={id} />;
}

// Also used by the isolated development preview; fixtures cannot replace live state.
export function SyncStatusIndicator({
  state,
  id,
}: {
  state: SyncStatusState;
  id?: string;
}) {
  const label = getSyncStatusLabel(state);
  return (
    <span
      id={id}
      className={`sync-status sync-status--${state.status}`}
      data-state={state.status}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      title={label}
    >
      <Icon
        name={statusIcons[state.status]}
        className="sync-state-icon"
        width="14"
        height="14"
      />
      <span className="sync-status-label">{label}</span>
    </span>
  );
}
