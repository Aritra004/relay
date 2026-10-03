import { useState, type FormEvent, type RefObject } from "react";
import { Icon } from "./icons";
import type { StageId } from "./workspace-data";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";

export function InlineItemCreator({
  stageId,
  active,
  inputRef,
  onStart,
  onCancel,
  onCreated,
}: {
  stageId: StageId;
  active: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onStart: () => void;
  onCancel: () => void;
  onCreated: (itemId: string) => void;
}) {
  const { actions } = useWorkspaceStore();
  const stageName = useWorkspaceSelector((state) => state.stages[stageId].name);
  // Keep an unfinished title when the user opens a different column's input.
  const [draftTitle, setDraftTitle] = useState("");

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const item = actions.createItem(draftTitle, stageId);
    if (!item) return;
    setDraftTitle("");
    onCreated(item.id);
    inputRef.current?.focus({ preventScroll: true });
  }

  function cancel() {
    setDraftTitle("");
    onCancel();
  }

  if (!active) {
    return (
      <button
        className="add-item"
        aria-label={`Add another item to ${stageName}`}
        onClick={onStart}
      >
        <Icon name="plus" width="14" height="14" />
        Add item
      </button>
    );
  }

  return (
    <form
      className="inline-item-form"
      aria-label={`Create item in ${stageName}`}
      onSubmit={submit}
    >
      <input
        ref={inputRef}
        className="inline-item-title"
        aria-label={`Item title for ${stageName}`}
        aria-describedby={`create-hint-${stageId}`}
        placeholder="Item title…"
        value={draftTitle}
        maxLength={180}
        autoComplete="off"
        enterKeyHint="done"
        onChange={(event) => setDraftTitle(event.target.value)}
        onKeyDown={(event) => {
          const composing =
            event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
          if (event.key === "Enter" && (composing || event.repeat)) {
            event.preventDefault();
          } else if (event.key === "Escape" && !composing) {
            event.preventDefault();
            event.stopPropagation();
            cancel();
          }
        }}
      />
      <div className="inline-item-actions">
        <span className="inline-item-hint" id={`create-hint-${stageId}`}>
          Enter to add<span className="sr-only">. Escape to cancel.</span>
        </span>
        <button type="button" className="inline-item-cancel" onClick={cancel}>
          Cancel
        </button>
        <button
          type="submit"
          className="inline-item-submit"
          aria-label={`Create item in ${stageName}`}
          disabled={!draftTitle.trim()}
        >
          Add
        </button>
      </div>
    </form>
  );
}
