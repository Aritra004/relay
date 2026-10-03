import { useRef, useState } from "react";
import type { StageId } from "./workspace-data";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";
import { RemoteChangeLabel } from "./remote-change";

export function StageTitle({
  stageId,
  onRenamed,
}: {
  stageId: StageId;
  onRenamed: (previous: string, name: string) => void;
}) {
  const store = useWorkspaceStore();
  const stage = useWorkspaceSelector((state) => state.stages[stageId]);
  const conflicted = useWorkspaceSelector((state) => state.syncMetadata.conflicts?.some((c) => c.status === "unresolved" && c.entityType === "stage" && c.entityId === stageId));
  const [editing, setEditing] = useState(false);
  // Only the unsaved input lives here; the displayed name comes from the store.
  const [draftName, setDraftName] = useState("");
  const editingRef = useRef(false);
  const titleRef = useRef<HTMLButtonElement>(null);
  const [baseVersion, setBaseVersion] = useState<number | null>(null);

  function startEditing() {
    if (conflicted) return;
    setDraftName(stage.name);
    setBaseVersion(stage.version ?? null);
    editingRef.current = true;
    setEditing(true);
  }

  function finishEditing(save: boolean, restoreFocus = false) {
    // Enter can also blur the input; commit a rename only once.
    if (!editingRef.current) return;
    editingRef.current = false;
    if (save && store.actions.renameStage(stageId, draftName, baseVersion)) {
      onRenamed(stage.name, store.getSnapshot().stages[stageId].name);
    }
    setDraftName("");
    setEditing(false);
    if (restoreFocus) {
      requestAnimationFrame(() =>
        titleRef.current?.focus({ preventScroll: true }),
      );
    }
  }

  return (
    <h2
      id={`stage-${stage.id}`}
      className={`stage-heading ${editing ? "is-editing" : ""}`}
      aria-label={stage.name}
    >
      {editing ? (
        <input
          className="stage-name-input"
          aria-label="Stage name"
          aria-describedby="stage-rename-help"
          value={draftName}
          maxLength={60}
          autoFocus
          autoComplete="off"
          enterKeyHint="done"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraftName(event.target.value)}
          onBlur={() => finishEditing(true)}
          onKeyDown={(event) => {
            if (
              event.nativeEvent.isComposing ||
              event.nativeEvent.keyCode === 229
            )
              return;
            if (event.key === "Enter" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              finishEditing(event.key === "Enter", true);
            }
          }}
        />
      ) : (
        <button
          ref={titleRef}
          type="button"
          className="stage-title"
          disabled={conflicted}
          title={`${stage.name} — Double-click to rename`}
          aria-label={`Rename ${stage.name} stage`}
          onDoubleClick={startEditing}
          onClick={(event) => {
            // Native keyboard activation (Enter/Space) has no pointer clicks.
            if (event.detail === 0) startEditing();
          }}
          onKeyDown={(event) => {
            if (event.key === "F2") {
              event.preventDefault();
              startEditing();
            }
          }}
        >
          {stage.name}
          {conflicted && <span className="conflict-badge">Conflict</span>}
          <RemoteChangeLabel entityId={stageId} />
        </button>
      )}
      {editing && (stage.version ?? null) !== baseVersion && (
        <span className="remote-change-label">Renamed remotely. Your draft is preserved; save to review the conflict.</span>
      )}
    </h2>
  );
}
