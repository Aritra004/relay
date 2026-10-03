import { useState } from "react";
import { SyncStatusIndicator } from "./sync-status";
import type { SyncStatusState } from "./sync-state";
import { defaultSyncPreview } from "./sync-inspector-data";

export const syncStatusPreviews = [
  { id: "synced", label: "Synced", state: { status: "synced" } },
  {
    id: "offline",
    label: "Offline",
    state: { status: "offline", pendingCount: 0 },
  },
  {
    id: "pending",
    label: "4 changes pending",
    state: { status: "pending", pendingCount: 4 },
  },
  {
    id: "syncing",
    label: "Syncing 4 changes...",
    state: { status: "syncing", pendingCount: 4 },
  },
  { id: "failed", label: "Sync failed", state: { status: "failed" } },
] as const satisfies readonly {
  id: string;
  label: string;
  state: SyncStatusState;
}[];

export type SyncPreviewId =
  | "demo"
  | (typeof syncStatusPreviews)[number]["id"];

export function SyncStatusPreview() {
  const [value, onChange] = useState<SyncPreviewId>("demo");
  const state =
    syncStatusPreviews.find((preview) => preview.id === value)?.state ??
    defaultSyncPreview;
  return (
    <fieldset className="sync-preview-controls">
      <legend>Sample connection states</legend>
      <label htmlFor="sync-preview-state">Sync state</label>
      <select
        id="sync-preview-state"
        value={value}
        aria-describedby="sync-preview-help"
        onChange={(event) => onChange(event.target.value as SyncPreviewId)}
      >
        <option value="demo">7 changes pending (sample)</option>
        {syncStatusPreviews.map((preview) => (
          <option key={preview.id} value={preview.id}>
            {preview.label}
          </option>
        ))}
      </select>
      <div className="sync-preview-output">
        <SyncStatusIndicator state={state} />
      </div>
      <p id="sync-preview-help">
        Sample indicator only. The workspace indicator and inspector always
        show the current store state. No changes are sent or cleared.
      </p>
    </fieldset>
  );
}
