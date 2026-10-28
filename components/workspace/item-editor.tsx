import { useEffect, useState } from "react";
import { Panel } from "./panel";
import type { StageId } from "./workspace-data";
import { Icon } from "./icons";
import { selectSelectedItem, selectStages } from "./workspace-store";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";
import { ConflictList } from "./conflict-resolution";
import { unresolvedConflicts } from "../../lib/conflict-contract";
import { EditingPresence } from "./workspace-presence";

export function ItemEditor({
  onStageChange,
  onClose,
}: {
  onStageChange: (stageId: StageId) => void;
  onClose: () => void;
}) {
  const store = useWorkspaceStore();
  const { actions } = store;
  const state = useWorkspaceSelector((snapshot) => snapshot);
  const item = selectSelectedItem(state);
  const stages = selectStages(state);
  const [emptyTitle, setEmptyTitle] = useState<{
    id: string;
    value: string;
  } | null>(null);
  useEffect(
    () => () => {
      store.sync.editing(null);
      store.presence.editing(null);
    },
    [store],
  );
  if (!item) return null;
  const conflicted = unresolvedConflicts(state.syncMetadata).some(
    (c) => c.entityType === "item" && c.entityId === item.id,
  );

  return (
    <Panel title={item.id} onClose={onClose}>
      <div
        className="item-form"
        onPointerDownCapture={() => store.presence.editing(item.id)}
        onKeyDownCapture={() => store.presence.editing(item.id)}
      >
        <div className="panel-body">
          <p className="eyebrow">ITEM DETAILS</p>
          <EditingPresence itemId={item.id} />
          <ConflictList entityId={item.id} />
          <label className="field-label" htmlFor="item-title">
            Title
          </label>
          <textarea
            id="item-title"
            className="title-input"
            placeholder="What needs to happen?"
            rows={3}
            maxLength={180}
            autoFocus
            onFocus={() => store.sync.editing(item.id)}
            onBlur={() => {
              setEmptyTitle(null);
              store.sync.editing(null);
            }}
            disabled={Boolean(state.storageError) || conflicted}
            aria-invalid={emptyTitle?.id === item.id}
            value={emptyTitle?.id === item.id ? emptyTitle.value : item.title}
            onChange={(event) => {
              const title = event.target.value;
              if (state.workspace.source === "server" && !title.trim())
                setEmptyTitle({ id: item.id, value: title });
              else {
                setEmptyTitle(null);
                actions.updateItem(item.id, { title });
              }
              store.presence.editing(item.id);
            }}
          />
          {emptyTitle?.id === item.id && (
            <p role="status">
              A title is required. Your previous title is still saved.
            </p>
          )}
          <div className="property-grid">
            <label htmlFor="item-stage">Stage</label>
            <select
              id="item-stage"
              disabled={Boolean(state.storageError) || conflicted}
              value={item.stageId}
              onChange={(event) => {
                const stageId = event.target.value as StageId;
                if (
                  actions.moveItem({
                    itemId: item.id,
                    stageId,
                    beforeItemId: null,
                  })
                ) {
                  onStageChange(stageId);
                }
              }}
            >
              {stages.map((stage) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name}
                </option>
              ))}
            </select>
          </div>
          <label
            className="field-label description-label"
            htmlFor="item-description"
          >
            Description
          </label>
          <textarea
            id="item-description"
            className="description-input"
            placeholder="Add a little context…"
            rows={6}
            maxLength={5000}
            onFocus={() => store.sync.editing(item.id)}
            onBlur={() => store.sync.editing(null)}
            aria-describedby={
              item.description.trim() ? undefined : "empty-description-hint"
            }
            disabled={Boolean(state.storageError) || conflicted}
            value={item.description}
            onChange={(event) => {
              const description = event.target.value;
              actions.updateItem(item.id, { description });
              store.presence.editing(item.id);
            }}
          />
          {!item.description.trim() && (
            <p className="empty-description-hint" id="empty-description-hint">
              No description yet. A little context is optional.
            </p>
          )}
          <p className="session-note">
            <Icon name="monitor" />{" "}
            {state.storageError
              ? "Changes are not saved. Retry local storage."
              : state.unsavedOperationCount > 0
                ? "Saving changes to this device..."
                : state.editingEntityId === item.id && item.changed
                  ? "Saved on this device. Finish editing this field to share changes."
                  : "Changes saved on this device."}
          </p>
          <button
            type="button"
            className="secondary-button"
            disabled={conflicted}
            onClick={() => {
              if (actions.deleteItem(item.id)) onClose();
            }}
          >
            Delete item
          </button>
        </div>
      </div>
    </Panel>
  );
}
