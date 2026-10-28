"use client";
/* Native links deliberately reach the offline navigation path of the service worker. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useState, useSyncExternalStore } from "react";
import { accountRegistry, accountWorkspaceRepository } from "@/lib/local-account";
import { readLastOpenedWorkspace } from "@/lib/last-workspace";
import type { StoredWorkspace } from "@/lib/local-db";
import { Icon } from "@/components/workspace/icons";
import { OfflineShell } from "@/components/workspace/offline-shell";
import { OnlineWorkspace } from "./online-workspace";

const subscribePath = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};

const subscribeConnection = (listener: () => void) => {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
};

export function OfflineWorkspaces() {
  // The service worker serves this public shell at the requested workspace URL.
  const path = useSyncExternalStore(subscribePath, () => window.location.pathname, () => "/offline");
  const match = /^\/workspaces\/([0-9a-f-]{36})\/?$/i.exec(path);
  return match ? <OnlineWorkspace key={match[1]} workspaceId={match[1]} /> : <CachedWorkspaceList />;
}

type CacheStatus = "reading" | "signed-out" | "ready" | "error";

function CachedWorkspaceList() {
  const online = useSyncExternalStore(subscribeConnection, () => navigator.onLine, () => true);
  const [status, setStatus] = useState<CacheStatus>("reading");
  const [lastOpenedId, setLastOpenedId] = useState<string | null>(null);
  const [workspaces, setWorkspaces] = useState<StoredWorkspace[]>([]);

  useEffect(() => accountRegistry.subscribe((account) => {
    setWorkspaces([]);
    if (account?.status !== "active" || !account.user) {
      setLastOpenedId(null);
      setStatus("signed-out");
      return;
    }
    const user = account.user;
    const last = readLastOpenedWorkspace();
    setLastOpenedId(last?.userId === user.id ? last.workspaceId : null);
    setStatus("reading");
    void accountWorkspaceRepository(user.id).listCachedWorkspaces().then(async (saved) => {
      if ((await accountRegistry.read())?.generation !== account.generation) return;
      setWorkspaces(saved.filter((workspace) => workspace.source === "server" && workspace.cachedForUserId === user.id));
      setStatus("ready");
    }).catch(() => setStatus("error"));
  }, () => setStatus("error")), []);

  const message =
    status === "reading" ? "Reading the cache on this device…"
    : status === "signed-out" ? "Sign in while connected to open the workspaces cached for your account. Nothing stored on this device is removed."
    : status === "error" ? "The local cache could not be read. Stored data was preserved."
    : workspaces.length === 0 ? "No workspaces are cached on this device yet. Open a workspace once while connected and it stays available offline."
    : null;

  return (
    <main className="account-page offline-page">
      <header className="offline-topline">
        <a href="/" className="account-brand">relay<span>.</span></a>
        <span className="offline-connection" data-online={online} role="status" aria-live="polite">
          <Icon name={online ? "monitor" : "cloud-off"} width="14" height="14" />
          {online ? "CONNECTED" : "OFFLINE"}
        </span>
      </header>

      <h1>Saved on this device<span className="heading-period">.</span></h1>
      {message && <p className="account-intro" role={status === "reading" ? "status" : undefined}>{message}</p>}

      {status === "ready" && workspaces.length > 0 && (
        <ul className="account-workspaces offline-workspaces" aria-label="Cached workspaces">
          {workspaces.map((workspace) => (
            <li key={workspace.id}>
              <a href={`/workspaces/${workspace.id}`}>
                <span className="offline-workspace-name">
                  <strong>{workspace.name}</strong>
                  {workspace.id === lastOpenedId && <span className="offline-tag">LAST OPENED</span>}
                </span>
                <span className="offline-workspace-open">
                  Open <Icon name="arrow" width="12" height="12" />
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <div className="offline-actions">
        {status === "signed-out" && <a className="primary-button" href="/auth/sign-in">Sign in</a>}
        <a className="secondary-button" href="/account">Your account</a>
      </div>

      <div className="offline-path" data-online={online}>
        <span className="offline-path-line" aria-hidden="true">
          <span>LOCAL</span>
          {online ? (
            <span className="path-line path-line--joined"><i /></span>
          ) : (
            <>
              <span className="path-line"><i /></span>
              <span className="path-break">&times;</span>
            </>
          )}
          <span className="server-label">SERVER</span>
        </span>
        {!online && <span className="offline-path-note">Changes will sync when connection returns.</span>}
      </div>

      <OfflineShell />
    </main>
  );
}
