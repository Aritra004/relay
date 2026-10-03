"use client";

import { useEffect, useState } from "react";

export function OfflineShell() {
  const [status, setStatus] = useState<"caching" | "ready" | "error">(
    "caching",
  );
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    let disposed = false;
    const fail = () => {
      if (!disposed) setStatus("error");
    };
    if (!("serviceWorker" in navigator)) {
      fail();
      return;
    }
    void navigator.serviceWorker
      .register("/sw.js", { updateViaCache: "none" })
      .then(async (registration) => {
        const worker = registration.installing;
        worker?.addEventListener("statechange", () => {
          if (worker.state === "redundant" && !registration.active) fail();
        });
        await navigator.serviceWorker.ready;
        if (!disposed) setStatus("ready");
      })
      .catch(fail);
    return () => {
      disposed = true;
    };
  }, [attempt]);

  if (process.env.NODE_ENV !== "production") return null;
  return (
    <div
      className={`offline-shell-status${status === "error" ? " is-error" : ""}`}
      role="status"
    >
      {status === "ready"
        ? "Ready for offline refresh"
        : status === "caching"
          ? "Preparing offline refresh…"
          : "Offline refresh unavailable. Keep this page open while offline."}
      {status === "error" && (
        <button
          onClick={() => {
            setStatus("caching");
            setAttempt((value) => value + 1);
          }}
        >
          Retry
        </button>
      )}
    </div>
  );
}
