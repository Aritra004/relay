"use client";
/* Offline navigation needs document requests handled by the service worker. */
import { useEffect, useState, useSyncExternalStore } from "react";
import { createServerWorkspace } from "@/lib/server-workspace";
import { WorkspaceProvider } from "@/components/workspace/workspace-provider";
import { Workspace } from "@/components/workspace/workspace";
import { OfflineShell } from "@/components/workspace/offline-shell";
import { rememberLastOpenedWorkspace } from "@/lib/last-workspace";

export function OnlineWorkspace({ workspaceId }: { workspaceId: string }) {
  const [controller] = useState(() => createServerWorkspace(workspaceId));
  const [recoveryError, setRecoveryError] = useState<string | null>(null);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getServerSnapshot);
  useEffect(() => {
    void controller.initialize(navigator.onLine);
    const unwatch = controller.watchAccount();
    const update = () => controller.setOnline(navigator.onLine);
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => { unwatch(); window.removeEventListener("online", update); window.removeEventListener("offline", update); };
  }, [controller]);
  useEffect(() => {
    // Recorded only once the workspace is actually shown from cache or server.
    const owner = state.store?.getSnapshot().workspace.cachedForUserId;
    if (state.store && owner) rememberLastOpenedWorkspace({ workspaceId, userId: owner });
  }, [state.store, workspaceId]);
  const blocked = state.store?.getSnapshot().editingBlocked || state.access === "unauthenticated" || state.access === "forbidden";
  async function downloadRecovery() {
    setRecoveryError(null);
    try {
    const data = await controller.exportRecovery();
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `relay-recovery-${workspaceId}.json`; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setRecoveryError("The browser could not read stored records. Your data has not been cleared; retry when local storage is available.");
    }
  }
  return <div className="server-workspace">
    {recoveryError && <p className="storage-notice" role="alert">{recoveryError}</p>}
    {state.access !== "online" && state.access !== "checking" && <div className="workspace-access-notice" role="status" data-access={state.access}>
      <span>{state.message}</span>
      <div>
        <a href="/offline">Cached workspaces</a>
        <a href="/account">Your workspaces</a>
        <button onClick={() => void controller.refresh()}>Retry connection</button>
        {state.access === "unauthenticated" && <a href="/auth/sign-in">Sign in</a>}
        {state.access === "error" && <><button onClick={() => void controller.recover()}>Recover cached board</button><button onClick={() => void downloadRecovery()}>Download recovery data</button></>}
      </div>
    </div>}
    {state.store && !blocked ? <WorkspaceProvider key={state.store.getSnapshot().workspace.cachedForUserId} store={state.store}><Workspace /></WorkspaceProvider>
      : <main className="account-page">
          <h1>{blocked ? "Workspace access needs attention" : state.access === "checking" ? "Opening workspace…" : "This workspace is not available locally"}</h1>
          <p>{blocked ? "Your stored workspace and pending changes have been preserved." : "Open this workspace once while signed in and connected to save it for offline use."}</p>
          <p><a href="/offline">Cached workspaces</a> &middot; <a href="/account">Your account</a></p><OfflineShell />
        </main>}
  </div>;
}
