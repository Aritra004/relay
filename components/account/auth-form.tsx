"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { authClient } from "@/lib/auth-client";
import { workspaceApi } from "@/lib/online-workspace";
import { accountRegistry } from "@/lib/local-account";

export function AuthForm({ mode }: { mode: "sign-in" | "sign-up" }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [verify, setVerify] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const signUp = mode === "sign-up";

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError("");
    try {
      if (verify) {
        const result = await authClient.emailOtp.verifyEmail({ email, otp: String(form.get("code")) });
        if (result.error) throw new Error(result.error.message ?? "The verification code could not be accepted.");
        const signedIn = await authClient.signIn.email({ email, password });
        if (signedIn.error) throw new Error(signedIn.error.message ?? "Please sign in again.");
      } else {
        const result = signUp
          ? await authClient.signUp.email({ email, password, name: String(form.get("name")).trim() })
          : await authClient.signIn.email({ email, password });
        if (result.error) {
          if (result.error.code === "EMAIL_NOT_VERIFIED") {
            const sent = await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
            if (sent.error) throw new Error(sent.error.message ?? "Could not send a verification code.");
            setVerify(true);
            return;
          }
          throw new Error(result.error.message ?? "Unable to sign in. Please try again.");
        }
        if (signUp && !result.data?.token) {
          setVerify(true);
          return;
        }
      }
      // A full navigation discards any anonymous prefetched route redirects.
      const { user } = await workspaceApi.session();
      await accountRegistry.remember(user);
      window.location.replace("/account");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to connect. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="account-page account-page--narrow">
      <Link className="account-brand" href="/">relay<span>.</span></Link>
      <p className="eyebrow">YOUR WORK, TOGETHER</p>
      <h1>{verify ? "Check your email" : signUp ? "Create your account" : "Welcome back"}</h1>
      <p className="account-intro">{verify ? `Enter the verification code sent to ${email}.` : "Sign in to create and access your online workspaces."}</p>
      <form onSubmit={submit} className="account-form">
        {verify ? <label>Verification code<input name="code" autoComplete="one-time-code" inputMode="numeric" required /></label> : <>
          {signUp && <label>Name<input name="name" autoComplete="name" required maxLength={120} /></label>}
          <label>Email<input name="email" type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
          <label>Password<input name="password" type="password" autoComplete={signUp ? "new-password" : "current-password"} required minLength={8} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        </>}
        {error && <p className="account-error" role="alert">{error}</p>}
        <button className="primary-button" disabled={busy}>{busy ? "Please wait…" : verify ? "Verify email" : signUp ? "Create account" : "Sign in"}</button>
      </form>
      {verify && <button className="account-text-button" disabled={busy} onClick={async () => {
        setBusy(true);
        setError("");
        try {
          const result = await authClient.emailOtp.sendVerificationOtp({ email, type: "email-verification" });
          if (result.error) setError(result.error.message ?? "Could not resend code.");
        } catch { setError("Unable to connect. Please try again."); }
        finally { setBusy(false); }
      }}>Resend code</button>}
      <p><Link href={signUp ? "/auth/sign-in" : "/auth/sign-up"}>{signUp ? "Already have an account? Sign in" : "New to Relay? Create an account"}</Link></p>
      <p className="account-local-note">Your local workspace and pending changes stay on this device.</p>
      <Link href="/">Continue in your local workspace →</Link>
    </main>
  );
}
