"use client";

import { useState } from "react";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";

export function WorkspaceDeveloperTools({
  onReset,
}: { onReset?: () => void } = {}) {
  const store = useWorkspaceStore();
  const state = useWorkspaceSelector((snapshot) => snapshot);
  const [confirming, setConfirming] = useState(false);
  const [resetError, setResetError] = useState<string | null>(null);
  const [resetComplete, setResetComplete] = useState(false);
  if (process.env.NODE_ENV !== "development" || !store.development) return null;
  const savedCount =
    state.pendingOperations.length - state.unsavedOperationCount;

  async function reset() {
    if (!store.development || state.isResetting) return;
    setResetError(null);
    setResetComplete(false);
    try {
      await store.development.resetWorkspace(navigator.onLine);
      setConfirming(false);
      setResetComplete(true);
      onReset?.();
    } catch {
      setResetError(
        store.getSnapshot().storageError ??
          "The local database could not be reset.",
      );
    }
  }

  return (
    <div className="workspace-developer-tools">
      <fieldset className="sync-preview-controls" disabled={state.isResetting}>
        <legend>Local database</legend>
        <p id="workspace-reset-help">
          Clear the demo database, including its workspaces, items, stages,
          pending operations, sync records, and unsaved edits, then restore the
          mock workspace. Account workspace caches and server data are preserved.
        </p>
        {confirming ? (
          <div className="developer-reset-confirmation">
            <p>
              Discard all demo data and restore a clean development workspace?
            </p>
            <div className="developer-reset-actions">
              <button
                className="secondary-button"
                onClick={() => {
                  void reset();
                }}
              >
                Clear database and reseed
              </button>
              <button
                className="secondary-button"
                onClick={() => setConfirming(false)}
              >
                Cancel reset
              </button>
            </div>
          </div>
        ) : (
          <button
            className="secondary-button"
            aria-describedby="workspace-reset-help"
            onClick={() => {
              setConfirming(true);
              setResetComplete(false);
            }}
          >
            Reset local database
          </button>
        )}
      </fieldset>
      {state.isResetting && <p role="status">Resetting local database…</p>}
      {resetError && (
        <p className="developer-reset-error" role="alert">
          {resetError}
        </p>
      )}
      {resetComplete && (
        <p role="status">Local database reset. The mock workspace is ready.</p>
      )}

      <section
        className="developer-queue"
        aria-labelledby="developer-queue-title"
      >
        <h3 id="developer-queue-title">
          Operation queue
          {state.restoration === "ready"
            ? ` (${state.pendingOperations.length})`
            : ""}
        </h3>
        {state.restoration === "ready" && (
          <>
            <p aria-live="polite">
              {savedCount} saved locally · {state.unsavedOperationCount} not yet
              saved
            </p>
            <p>
              Creation order, oldest first. Expand an entry to inspect its full
              operation.
            </p>
          </>
        )}
        {state.restoration !== "ready" ? (
          <p>
            The queue could not be restored. Existing stored operations have not
            been cleared.
          </p>
        ) : state.pendingOperations.length === 0 ? (
          <p>No queued operations.</p>
        ) : (
          <ol>
            {state.pendingOperations.map((operation, index) => (
              <li key={operation.id}>
                <details>
                  <summary>
                    #{index + 1} {operation.type}
                    <span>
                      {index < savedCount ? "Saved locally" : "Not yet saved"}
                    </span>
                  </summary>
                  <pre tabIndex={0} aria-label={`Operation ${index + 1} JSON`}>
                    {JSON.stringify(operation, null, 2)}
                  </pre>
                </details>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
