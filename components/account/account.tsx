"use client";

import { useEffect, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { workspaceApi, type AccountUser, type WorkspaceSummary } from "@/lib/online-workspace";
import { accountRegistry } from "@/lib/local-account";

export function Account() {
  const router = useRouter();
  const [data, setData] = useState<{ user: AccountUser; workspaces: WorkspaceSummary[] } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    accountRegistry.read().then(async (current) => {
      const [session, result] = await Promise.all([workspaceApi.session(controller.signal), workspaceApi.list(controller.signal)]);
      if (controller.signal.aborted) return;
      await accountRegistry.remember(session.user, current?.generation ?? null);
      setData({ ...session, ...result });
    })
      .catch((failure) => { if (!controller.signal.aborted) setError(failure.message); });
    return () => controller.abort();
  }, [retry]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name"));
    setBusy(true); setError("");
    try {
      const result = await workspaceApi.create(name);
      router.push(`/workspaces/${result.workspace.id}`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to create workspace."); }
    finally { setBusy(false); }
  }

  async function signOut() {
    setBusy(true); setError("");
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error(result.error.message ?? "Unable to sign out.");
      await accountRegistry.signOut();
      // Authentication never resets IndexedDB or acknowledges pending operations.
      window.location.replace("/auth/sign-in");
    } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to sign out."); }
    finally { setBusy(false); }
  }

  return <main className="account-page">
    <div className="account-topline"><Link className="account-brand" href="/">relay<span>.</span></Link><Link href="/offline">Cached workspaces →</Link></div>
    <p className="eyebrow">YOUR ACCOUNT</p>
    <h1>{data ? data.user.name : "Your workspaces"}</h1>
    {data && <div className="account-topline"><p className="account-intro">{data.user.email}</p><button className="secondary-button" onClick={signOut} disabled={busy}>Sign out</button></div>}
    {error && <div role="alert" className="account-error"><p>{error}</p>{!data && <button className="secondary-button" onClick={() => { setError(""); setRetry(retry + 1); }}>Try again</button>}</div>}
    {!data && !error && <p role="status">Loading your account…</p>}
    {data && <>
      <section className="account-section"><h2>Online workspaces</h2>
        {data.workspaces.length ? <ul className="account-workspaces">{data.workspaces.map((workspace) => <li key={workspace.id}>
          <a href={`/workspaces/${workspace.id}`}><strong>{workspace.name}</strong><span>{workspace.role} · Updated {new Date(workspace.updatedAt).toLocaleDateString()}</span></a>
        </li>)}</ul> : <p className="account-intro">Create your first online workspace below.</p>}
      </section>
      <section className="account-section"><h2>Create a workspace</h2><form className="account-form account-create-form" onSubmit={create}>
        <label>Workspace name<input name="name" required maxLength={120} placeholder="e.g. Product team" /></label>
        <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : "Create workspace"}</button>
      </form></section>
    </>}
    <p className="account-local-note">Workspaces you open are cached on this device. Their pending changes are preserved when you sign in or out.</p>
  </main>;
}
