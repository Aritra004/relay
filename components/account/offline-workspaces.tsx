"use client";
/* Native links deliberately reach the service worker's offline navigation path. */
/* eslint-disable @next/next/no-html-link-for-pages */
import { useEffect, useState, useSyncExternalStore } from "react";
import { accountRegistry, accountWorkspaceRepository } from "@/lib/local-account";
import type { StoredWorkspace } from "@/lib/local-db";
import { OnlineWorkspace } from "./online-workspace";
import { OfflineShell } from "@/components/workspace/offline-shell";

const subscribePath = (listener: () => void) => {
  window.addEventListener("popstate", listener);
  return () => window.removeEventListener("popstate", listener);
};

export function OfflineWorkspaces() {
  // The service worker serves this public shell at the requested workspace URL.
  const path = useSyncExternalStore(subscribePath, () => window.location.pathname, () => "/offline");
  const match = /^\/workspaces\/([0-9a-f-]{36})\/?$/i.exec(path);
  return match ? <OnlineWorkspace key={match[1]} workspaceId={match[1]} /> : <CachedWorkspaceList />;
}

function CachedWorkspaceList() {
  const [workspaces, setWorkspaces] = useState<StoredWorkspace[]>([]);
  const [message, setMessage] = useState("Reading this device’s cache…");
  useEffect(() => accountRegistry.subscribe((account) => {
    setWorkspaces([]);
    if (account?.status !== "active" || !account.user) {
      setMessage("Sign in while connected to open your account’s cached workspaces. Existing data is preserved.");
      return;
    }
    void accountWorkspaceRepository(account.user.id).listCachedWorkspaces().then(async (saved) => {
      if ((await accountRegistry.read())?.generation !== account.generation) return;
      setWorkspaces(saved.filter((workspace) => workspace.source === "server" && workspace.cachedForUserId === account.user?.id));
      setMessage("Workspaces saved for this account on this device. Offline edits stay local until synchronization is available.");
    }).catch(() => setMessage("Unable to read the local cache. Stored data was preserved."));
  }, () => setMessage("Unable to read the local account.")), []);
  return <main className="account-page">
    <a href="/" className="account-brand">relay<span>.</span></a>
    <h1>Cached workspaces</h1><p className="account-intro">{message}</p>
    <ul className="account-workspaces">{workspaces.map((workspace) => <li key={workspace.id}><a href={`/workspaces/${workspace.id}`}>{workspace.name}</a></li>)}</ul>
    <p><a href="/account">Your account</a> · <a href="/">Local workspace</a></p>
    <OfflineShell />
  </main>;
}
