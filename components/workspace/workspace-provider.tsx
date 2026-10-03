"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  createWorkspaceStore,
  type WorkspaceState,
  type WorkspaceStore,
} from "./workspace-store";
import { OfflineShell } from "./offline-shell";
import { WorkspaceDeveloperTools } from "./workspace-developer-tools";
import { startWorkspaceSync } from "../../lib/workspace-sync";
import { startWorkspaceRealtime } from "../../lib/workspace-realtime";
import { startWorkspacePresence } from "../../lib/workspace-presence";

const WorkspaceContext = createContext<WorkspaceStore | null>(null);

export function WorkspaceProvider({
  children,
  store: suppliedStore,
}: {
  children: ReactNode;
  store?: WorkspaceStore;
}) {
  const [store] = useState(() => suppliedStore ?? createWorkspaceStore());
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const state = useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );

  useEffect(() => {
    void store.persistence.initialize().catch(() => {
      /* Displayed from store state. */
    });
  }, [store]);

  useEffect(() => {
    if (state.unsavedOperationCount === 0) return;
    const warnBeforeLeaving = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnBeforeLeaving);
    return () => window.removeEventListener("beforeunload", warnBeforeLeaving);
  }, [state.unsavedOperationCount]);

  function downloadUnsavedWork() {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(store.getSnapshot(), null, 2)], {
        type: "application/json",
      }),
    );
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "relay-workspace-recovery.json";
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function downloadRecoveryData() {
    setRecoveryError(null);
    try {
    const data = await store.persistence.exportRecovery();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "relay-local-recovery.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setRecoveryError("Stored records could not be read. Retry when browser storage is available. Existing data has not been cleared.");
    }
  }

  useEffect(() => {
    const updateConnection = () => store.setOnline(navigator.onLine);
    updateConnection();
    window.addEventListener("online", updateConnection);
    window.addEventListener("offline", updateConnection);
    return () => {
      window.removeEventListener("online", updateConnection);
      window.removeEventListener("offline", updateConnection);
    };
  }, [store]);

  useEffect(() => {
    const sync = startWorkspaceSync(store);
    const stopRealtime = startWorkspaceRealtime(store, sync);
    const stopPresence = startWorkspacePresence(store);
    return () => { stopPresence(); stopRealtime(); sync(); };
  }, [store]);

  return (
    <WorkspaceContext.Provider value={store}>
      <OfflineShell />
      {state.storageError && (
        <aside className="storage-notice" role="alert">
          <div>
            <strong>
              {state.unsavedOperationCount > 0
                ? "Changes are not saved"
                : "Workspace storage unavailable"}
            </strong>
            <p>{state.storageError}</p>
            {recoveryError && <p>{recoveryError}</p>}
            {state.unsavedOperationCount > 0 && (
              <p>
                {state.unsavedOperationCount} changes are still in memory.
                Editing is paused until saving succeeds.
              </p>
            )}
          </div>
          <button
            className="secondary-button"
            onClick={() => {
              void store.persistence.retry().catch(() => {});
            }}
          >
            Retry local storage
          </button>
          <button className="secondary-button" onClick={() => void downloadRecoveryData()}>Download stored recovery data</button>
          {state.unsavedOperationCount > 0 && (
            <button className="secondary-button" onClick={downloadUnsavedWork}>
              Download unsaved work
            </button>
          )}
        </aside>
      )}
      {state.restoration === "ready" ? (
        children
      ) : (
        <main
          className="workspace-loading"
          aria-busy={state.restoration === "loading"}
        >
          <p className="eyebrow">RELAY / LOCAL WORKSPACE</p>
          <p role="status">
            {state.restoration === "loading"
              ? "Restoring your workspace…"
              : "Your workspace could not be restored. Stored data has been preserved."}
          </p>
          {process.env.NODE_ENV === "development" &&
            state.restoration === "error" && (
              <details className="sync-inspector-preview">
                <summary>Development tools</summary>
                <WorkspaceDeveloperTools />
              </details>
            )}
        </main>
      )}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceStore() {
  const store = useContext(WorkspaceContext);
  if (!store)
    throw new Error("Workspace components require WorkspaceProvider.");
  return store;
}

// Select primitives or existing snapshot objects. Derive new arrays after this hook
// so React always receives a stable snapshot between store notifications.
export function useWorkspaceSelector<T>(
  selector: (state: WorkspaceState) => T,
) {
  const store = useWorkspaceStore();
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getSnapshot()),
    () => selector(store.getServerSnapshot()),
  );
}
