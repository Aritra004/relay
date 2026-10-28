"use client";
/* Full navigations deliberately reach the service worker's offline shell. */
import { useEffect } from "react";
import { accountRegistry } from "@/lib/local-account";
import { readLastOpenedWorkspace } from "@/lib/last-workspace";

// "/" reopens the workspace this device opened last. The workspace page checks
// access again; without a usable record the account page takes over.
export function Home() {
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const last = readLastOpenedWorkspace();
      let target = navigator.onLine ? "/account" : "/offline";
      if (last) {
        const account = await accountRegistry.read().catch(() => undefined);
        if (account?.status === "active" && account.user?.id === last.userId) {
          target = `/workspaces/${last.workspaceId}`;
        }
      }
      if (!cancelled) window.location.replace(target);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="workspace-loading home-loading" aria-busy="true">
      <p className="eyebrow">RELAY</p>
      <p role="status">Opening your last workspace…</p>
      <p className="home-links">
        <a href="/account">Your account</a>
        <span aria-hidden="true">·</span>
        <a href="/offline">Cached workspaces</a>
      </p>
    </main>
  );
}
