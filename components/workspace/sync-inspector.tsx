import type { ReactNode } from "react";
import { Icon } from "./icons";
import { Panel } from "./panel";
import { getSyncSnapshot } from "./sync-inspector-data";
import { selectSyncState } from "./sync-state";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";
import { ConflictList, ConflictHistory } from "./conflict-resolution";
import { unresolvedConflicts } from "../../lib/conflict-contract";

const activityLabels = {
  pending: "Queued",
  confirmed: "Confirmed",
  sending: "Sending",
  failed: "Failed",
  local: "Local only",
};

export function SyncInspector({
  onClose,
  children,
}: {
  onClose: () => void;
  children?: ReactNode;
}) {
  const workspaceState = useWorkspaceSelector((state) => state);
  const store = useWorkspaceStore();
  const state = selectSyncState(workspaceState);
  const snapshot = getSyncSnapshot(workspaceState);

  return (
    <Panel
      title="Sync Inspector"
      id="sync-inspector"
      variant="compact"
      onClose={onClose}
    >
      <div className={`sync-inspector sync-inspector--${state.status}`}>
        <div className="sync-inspector-caption">
          <span className="eyebrow">CONNECTION & SHARED STATE</span>
          <span className="sync-preview-tag">This device</span>
        </div>
        <p className="sync-inspector-summary">{snapshot.summary}</p>
        {snapshot.pendingCount > 100 && <p>Showing the latest 100 pending changes. All {snapshot.pendingCount} remain saved.</p>}
        {workspaceState.syncMetadata.recoveryMessage && <p role="status">{workspaceState.syncMetadata.recoveryMessage}</p>}
        {workspaceState.workspace.source === "server" && (
          <button
            className="secondary-button"
            onClick={() =>
              void store.upload.retry().catch(store.upload.storageFailure)
            }
          >
            {workspaceState.syncMetadata.uploadFailure
              ? "Retry sync"
              : "Sync now"}
          </button>
        )}
        <p className="conflict-count" role="status">
          {unresolvedConflicts(workspaceState.syncMetadata).length} unresolved{" "}
          {unresolvedConflicts(workspaceState.syncMetadata).length === 1
            ? "conflict"
            : "conflicts"}
        </p>
        <ConflictList />
        <ConflictHistory />

        <div className="sync-inspector-path" aria-hidden="true">
          <Icon name="monitor" width="14" height="14" />
          <span>LOCAL</span>
          <span className="sync-inspector-track">
            {snapshot.pendingCount > 0 && (
              <span className="sync-inspector-dots">
                <i />
                <i />
                <i />
              </span>
            )}
          </span>
          <Icon
            name={
              state.status === "synced"
                ? "check"
                : state.status === "syncing"
                  ? "arrow"
                  : "close"
            }
            width="13"
            height="13"
          />
          <span className="sync-inspector-track" />
          <span>SERVER</span>
        </div>

        <dl className="sync-inspector-metrics">
          {workspaceState.workspace.source === "server" && (
            <>
              <div><dt>Presence count</dt><dd>{workspaceState.presence.members.filter((m) => m.status === "online").length}</dd></div>
              {workspaceState.presence.error && <div><dt>Presence error</dt><dd>{workspaceState.presence.error}</dd></div>}
              <div>
                <dt>Realtime</dt>
                <dd className="realtime-status">
                  {workspaceState.realtime.status}
                </dd>
              </div>
              <div>
                <dt>Latest received server version</dt>
                <dd>
                  {workspaceState.realtime.latestReceivedServerVersion ??
                    "None"}
                </dd>
              </div>
              <div>
                <dt>Latest remote operation</dt>
                <dd>
                  {workspaceState.realtime.latestRemoteOperation
                    ? `${workspaceState.realtime.latestRemoteOperation.operation.type} · version ${workspaceState.realtime.latestRemoteOperation.serverVersion}`
                    : "None this session"}
                </dd>
              </div>
              <div>
                <dt>Catch-up required</dt>
                <dd>
                  {workspaceState.realtime.catchUpRequired ? "Yes" : "No"}
                </dd>
              </div>
              <div>
                <dt>Last realtime event</dt>
                <dd>
                  {workspaceState.realtime.lastEventAt ? (
                    <time dateTime={workspaceState.realtime.lastEventAt}>
                      {new Date(
                        workspaceState.realtime.lastEventAt,
                      ).toLocaleTimeString()}
                    </time>
                  ) : (
                    "None"
                  )}
                </dd>
              </div>
              {workspaceState.realtime.error && (
                <div>
                  <dt>Realtime error</dt>
                  <dd>{workspaceState.realtime.error}</dd>
                </div>
              )}
            </>
          )}
          <div>
            <dt>Current sync phase</dt>
            <dd aria-live="polite">{snapshot.phase}</dd>
          </div>
          <div>
            <dt>Latest server version</dt>
            <dd>{snapshot.currentServerVersion ?? "Unknown"}</dd>
          </div>
          <div>
            <dt>Received remote operations</dt>
            <dd>{snapshot.receivedRemoteOperations}</dd>
          </div>
          {workspaceState.syncMetadata.uploadFailure && (
            <>
              <div>
                <dt>Current error</dt>
                <dd>{workspaceState.syncMetadata.uploadFailure.code}</dd>
              </div>
              <div>
                <dt>Attempts</dt>
                <dd>
                  {workspaceState.syncMetadata.uploadFailure.attempts} / 5
                </dd>
              </div>
              <div>
                <dt>Next retry</dt>
                <dd>
                  {workspaceState.syncMetadata.uploadFailure.retryAt ??
                    "Paused"}
                </dd>
              </div>
            </>
          )}
          <div>
            <dt>Upload progress</dt>
            <dd className="sync-upload-progress">{snapshot.uploadProgress}</dd>
          </div>
          <div>
            <dt>Connection</dt>
            <dd className="sync-inspector-connection">
              <Icon
                name={
                  state.status === "offline"
                    ? "cloud-off"
                    : state.status === "failed"
                      ? "alert-circle"
                      : state.status === "pending"
                        ? "monitor"
                        : "check-circle"
                }
                width="13"
                height="13"
              />
              {snapshot.connection}
            </dd>
          </div>
          <div>
            <dt>Local revision</dt>
            <dd>{snapshot.localVersion}</dd>
          </div>
          <div>
            <dt>Last confirmed server version</dt>
            <dd>{snapshot.serverVersion ?? "Not connected"}</dd>
          </div>
          <div>
            <dt>Saved local revision</dt>
            <dd>{snapshot.persistedLocalRevision}</dd>
          </div>
          <div>
            <dt>Unsaved operations</dt>
            <dd>{snapshot.unsavedCount}</dd>
          </div>
          <div>
            <dt>Pending operations</dt>
            <dd
              aria-live="polite"
              aria-atomic="true"
              className={
                snapshot.pendingCount > 0 ? "sync-inspector-pending" : undefined
              }
            >
              {snapshot.pendingCount}
            </dd>
          </div>
        </dl>

        {workspaceState.presence.members.length > 0 && <details className="sync-inspector-preview"><summary>Collaborator presence</summary>
          {workspaceState.presence.members.map((m) => <p key={m.userId}>{m.displayName} · {m.status} · Last seen <time dateTime={m.lastSeen}>{new Date(m.lastSeen).toLocaleTimeString()}</time><br /><small>{m.userId}</small></p>)}
        </details>}

        {snapshot.pendingCount === 0 && (
          <p
            className={`sync-inspector-queue-empty${state.status === "synced" ? " is-synced" : ""}`}
            role="status"
          >
            <Icon
              name={state.status === "synced" ? "check-circle" : "check"}
              width="14"
              height="14"
            />
            {state.status === "synced"
              ? "Synced with server"
              : "No pending operations"}
          </p>
        )}

        <div className="sync-inspector-last-sync">
          <span>Last successful sync</span>
          {snapshot.lastSync ? (
            <time>{snapshot.lastSync}</time>
          ) : (
            <span>Not connected</span>
          )}
        </div>
        {snapshot.lastSnapshot && (
          <div className="sync-inspector-last-sync">
            <span>Snapshot cached</span>
            <time dateTime={snapshot.lastSnapshot}>
              {snapshot.lastSnapshot}
            </time>
          </div>
        )}

        <section
          className="sync-inspector-activity"
          aria-labelledby="sync-activity-title"
        >
          <div className="sync-inspector-section-heading">
            <h2 id="sync-activity-title">Operation activity</h2>
            <span>Pending and recent</span>
          </div>
          {snapshot.activity.length > 0 ? (
            <ol>
              {snapshot.activity.map((activity) => (
                <li
                  key={activity.id}
                  className={`sync-activity sync-activity--${activity.state}`}
                >
                  <span className="sync-activity-mark" aria-hidden="true">
                    <Icon
                      name={
                        activity.state === "confirmed"
                          ? "check"
                          : activity.state === "failed"
                            ? "alert-circle"
                            : activity.state === "sending"
                              ? "arrow"
                              : "monitor"
                      }
                      width="12"
                      height="12"
                    />
                  </span>
                  <div className="sync-activity-content">
                    <div className="sync-activity-heading">
                      <span className="sync-activity-label">
                        {activity.label}
                      </span>
                      <span className="sync-activity-state">
                        {activityLabels[activity.state]}
                      </span>
                      <time dateTime={activity.timestamp}>{activity.time}</time>
                    </div>
                    <p>{activity.detail}</p>
                  </div>
                </li>
              ))}
            </ol>
          ) : (
            <p className="sync-inspector-empty">
              No pending operations yet. New changes will appear here.
            </p>
          )}
        </section>

        <p className="sync-inspector-disclaimer">
          {workspaceState.workspace.source === "server"
            ? "Remote changes are pulled before local changes are uploaded. Unresolved conflicts pause only the affected items and their dependencies."
            : "Changes and pending operations stay on this device. Remote sync is not connected."}
        </p>
        {children && (
          <details className="sync-inspector-preview">
            <summary>Development tools</summary>
            {children}
          </details>
        )}
      </div>
    </Panel>
  );
}
