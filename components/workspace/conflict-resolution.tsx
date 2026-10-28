import { useState } from "react";
import {
  unresolvedConflicts,
  type ConflictRecord,
  type ConflictField,
} from "../../lib/conflict-contract";
import { Icon } from "./icons";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";

const labels: Record<ConflictField, string> = {
  title: "Title",
  description: "Description",
  move: "Move",
  delete: "Deletion",
  name: "Stage name",
  reference: "Move destination",
  identity: "Item identity",
  history: "Saved change",
};
export function conflictTitle(conflict: ConflictRecord) {
  return `${conflict.fields.map((field) => labels[field]).join(" and ")} conflict`;
}

export function ConflictResolution({ conflict }: { conflict: ConflictRecord }) {
  const store = useWorkspaceStore();
  const state = useWorkspaceSelector((s) => s);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const deleted =
    conflict.serverEntity === null && conflict.entityType === "item";
  const stageName = (id: string | null | undefined) =>
    id ? (state.stages[id]?.name ?? id) : "No stage";
  const value = (side: "client" | "server", field: ConflictField) => {
    const values =
      side === "client" ? conflict.clientValues : conflict.serverValues;
    if (field === "move" || field === "reference") {
      const stage = stageName(values.move);
      const anchor = values.beforeItemId;
      return `${stage}${anchor ? ` · before ${state.items[anchor]?.title ?? "another item"}` : anchor === null ? " · end of stage" : ""}`;
    }
    if (field === "delete" || field === "history" || field === "identity") {
      if (side === "server" && deleted) return "Deleted";
      if (side === "client" && conflict.operation.type === "DELETE_ITEM")
        return "Delete item";
      const item =
        side === "client" ? conflict.localItem : conflict.serverEntity;
      if (item && "title" in item)
        return `${item.title || "Untitled item"}\n${item.description || "No description"}\n${stageName(item.stageId)}`;
    }
    return values[field] ?? "Empty";
  };
  async function resolve(choice: "mine" | "server") {
    setBusy(true);
    setError(null);
    try {
      await store.sync.resolve(
        conflict.id,
        choice,
        conflict.serverWorkspaceVersion,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Your decision could not be saved. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }
  const itemName =
    conflict.localItem?.title ||
    (conflict.serverEntity && "title" in conflict.serverEntity
      ? conflict.serverEntity.title
      : state.stages[conflict.entityId]?.name) ||
    "Untitled item";
  return (
    <section
      className="conflict-resolution"
      aria-label={`${conflictTitle(conflict)}: ${itemName}`}
    >
      <h3>
        <Icon name="alert-circle" width="14" height="14" />
        {conflictTitle(conflict)}
      </h3>
      <p className="conflict-entity-name">{itemName}</p>
      <p>
        {deleted
          ? "Someone deleted this item while you were working. Your changes are saved on this device."
          : "Both versions are saved. Choose which one to keep."}
      </p>
      {conflict.fields.map((field) => (
        <div key={field} className="conflict-comparison">
          <h4>{labels[field]}</h4>
          <div>
            <span>
              {field === "move" || field === "reference"
                ? "Your move"
                : "Your version"}
            </span>
            <p>{value("client", field)}</p>
          </div>
          <div>
            <span>
              {field === "move" || field === "reference"
                ? "Remote move"
                : "Server version"}
            </span>
            <p>{value("server", field)}</p>
          </div>
        </div>
      ))}
      <div className="conflict-actions">
        <button
          className="primary-button"
          disabled={busy || !!state.storageError}
          onClick={() => void resolve("mine")}
        >
          {deleted ? "Restore item with local edits" : "Keep mine"}
        </button>
        <button
          className="secondary-button"
          disabled={busy || !!state.storageError}
          onClick={() => void resolve("server")}
        >
          {deleted ? "Keep deleted" : "Use server version"}
        </button>
      </div>
      {error && <p role="status">{error}</p>}
      <p className="conflict-meta">
        Unresolved · {conflict.operation.type} ·{" "}
        <time dateTime={conflict.detectedAt}>
          {new Date(conflict.detectedAt).toLocaleString()}
        </time>
      </p>
    </section>
  );
}

export function ConflictList({ entityId }: { entityId?: string }) {
  const state = useWorkspaceSelector((s) => s);
  const conflicts = unresolvedConflicts(state.syncMetadata).filter(
    (c) => !entityId || c.entityId === entityId,
  );
  return (
    <>
      {conflicts.map((c) => (
        <ConflictResolution key={c.id} conflict={c} />
      ))}
    </>
  );
}

export function ConflictHistory() {
  const records = useWorkspaceSelector((s) => s.syncMetadata.conflicts);
  const recent = (records ?? [])
    .filter((c) => c.status === "resolved")
    .slice(-20)
    .reverse();
  if (!recent.length) return null;
  return (
    <section className="conflict-history" aria-label="Recent conflict history">
      <h2>Recent conflict history</h2>
      <ol>
        {recent.map((c) => (
          <li key={c.id}>
            <p>
              {conflictTitle(c)} resolved —{" "}
              {c.resolution === "mine"
                ? "kept local version"
                : "used server version"}
            </p>
            <span>
              {c.localItem?.title || c.entityId} · {c.operation.type}
            </span>
            <time dateTime={c.resolvedAt}>
              {new Date(c.resolvedAt!).toLocaleString()}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}
