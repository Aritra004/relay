"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type UIEvent as ReactUIEvent,
} from "react";
import { flushSync } from "react-dom";
import Link from "next/link";
import { Icon } from "./icons";
import { ItemEditor } from "./item-editor";
import { InlineItemCreator } from "./inline-item-creator";
import { Panel } from "./panel";
import { StageTitle } from "./stage-title";
import { SyncStatus } from "./sync-status";
import { WorkspacePresence } from "./workspace-presence";
import { SyncInspector } from "./sync-inspector";
import { SyncStatusPreview } from "./sync-status-preview";
import {
  BoardDrag,
  DraggableItem,
  DropLane,
  DropList,
  MobileStageTarget,
} from "./board-drag";
import type { StageId } from "./workspace-data";
import {
  selectBoard,
  selectItems,
  selectSelectedItem,
  selectStages,
  type ItemFilters,
  type ItemMoveDirection,
} from "./workspace-store";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";

const movementKeys: Partial<Record<string, ItemMoveDirection>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

function StageMark({ stage }: { stage: StageId }) {
  return (
    <span className={`stage-mark stage-mark--${stage}`} aria-hidden="true">
      {stage === "shipped" && <Icon name="check" width="11" height="11" />}
    </span>
  );
}

export function Workspace() {
  const store = useWorkspaceStore();
  const state = useWorkspaceSelector((snapshot) => snapshot);
  const { workspace, selectedItemId } = state;
  const items = selectItems(state);
  const stages = selectStages(state);
  const [query, setQuery] = useState("");
  const [onlyMine, setOnlyMine] = useState(false);
  const [category, setCategory] =
    useState<ItemFilters["category"]>("All categories");
  // These select the visible controls/viewport, never a card's actual stage.
  const [mobileStage, setMobileStage] = useState<StageId>(state.stageOrder[0]);
  const [creationStage, setCreationStage] = useState<StageId | null>(null);
  const [panel, setPanel] = useState<"sync" | "help" | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const creationInputRef = useRef<HTMLInputElement>(null);
  const creationTriggerRef = useRef<HTMLElement | null>(null);

  const openInlineCreate = useCallback(
    (stageId: StageId) => {
      creationTriggerRef.current =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      flushSync(() => {
        setMobileStage(stageId);
        setCreationStage(stageId);
      });
      creationInputRef.current?.focus({ preventScroll: true });
      creationInputRef.current?.scrollIntoView({
        block: "nearest",
        inline: "nearest",
      });
    },
    [setMobileStage, setCreationStage],
  );

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target;
      if (
        selectedItemId ||
        panel ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        (target instanceof HTMLElement &&
          (target.isContentEditable ||
            ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)))
      )
        return;
      if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        openInlineCreate(mobileStage);
      } else if (event.key === "?") {
        setPanel("help");
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selectedItemId, panel, mobileStage, openInlineCreate]);

  const selectedItem = selectSelectedItem(state);

  const board = selectBoard(state, { query, onlyMine, category });
  const visibleItemCount = board.reduce(
    (count, lane) => count + lane.items.length,
    0,
  );
  const filtered =
    query.trim() !== "" || onlyMine || category !== "All categories";
  const workspaceEmpty = items.length === 0;

  function closeItemEditor() {
    flushSync(() => store.selectItem(null));
    // Moving lanes remounts the card, so restore focus to its current button.
    const card = document
      .getElementById(`item-title-${selectedItemId}`)
      ?.closest("button");
    if (card && card.getClientRects().length > 0) {
      card.focus({ preventScroll: true });
      card.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else {
      searchRef.current?.focus({ preventScroll: true });
    }
  }

  // Creation is already committed. This callback only reveals the new card.
  function revealCreatedItem(itemId: string) {
    const next = store.getSnapshot();
    const item = next.items[itemId];
    if (!item) return;
    flushSync(() => {
      const hiddenBySearch = !`${item.id} ${item.title}`
        .toLowerCase()
        .includes(query.trim().toLowerCase());
      const hiddenByCategory =
        category !== "All categories" && category !== item.label;
      setMobileStage(item.stageId);
      if (hiddenBySearch) setQuery("");
      if (hiddenByCategory) setCategory("All categories");
      setAnnouncement(
        `${item.title} created in ${next.stages[item.stageId].name}.${
          hiddenBySearch || hiddenByCategory
            ? " Filters cleared to show the new item."
            : ""
        }`,
      );
    });
    document
      .getElementById(`item-title-${itemId}`)
      ?.closest("button")
      ?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function cancelCreating() {
    const stageId = creationStage;
    flushSync(() => setCreationStage(null));
    const trigger = creationTriggerRef.current;
    if (trigger?.isConnected && trigger.getClientRects().length > 0) {
      trigger.focus({ preventScroll: true });
    } else {
      document
        .getElementById(`add-item-${stageId}`)
        ?.focus({ preventScroll: true });
    }
  }

  function resetFilters() {
    setQuery("");
    setOnlyMine(false);
    setCategory("All categories");
  }

  function updateVisibleStage(event: ReactUIEvent<HTMLDivElement>) {
    if (!window.matchMedia("(max-width: 700px)").matches) return;
    const boardBounds = event.currentTarget.getBoundingClientRect();
    let visibleStage = mobileStage;
    let widestVisiblePortion = 0;

    for (const stage of stages) {
      const bounds = document
        .getElementById(`lane-${stage.id}`)
        ?.getBoundingClientRect();
      if (!bounds) continue;
      const visibleWidth =
        Math.min(bounds.right, boardBounds.right) -
        Math.max(bounds.left, boardBounds.left);
      if (visibleWidth > widestVisiblePortion) {
        widestVisiblePortion = visibleWidth;
        visibleStage = stage.id;
      }
    }

    // Swiping keeps the selector and New item action on the visible stage.
    if (visibleStage !== mobileStage) setMobileStage(visibleStage);
  }

  // Movement is already committed. Restore focus and announce the stored result.
  function revealMovedItem(itemId: string) {
    const next = store.getSnapshot();
    const moved = next.items[itemId];
    if (!moved) return;
    const laneItems = next.itemOrderByStage[moved.stageId];
    flushSync(() => {
      setMobileStage(moved.stageId);
      setAnnouncement(
        `${moved.title.trim() || "Untitled item"} moved to ${next.stages[moved.stageId].name}, position ${laneItems.indexOf(itemId) + 1} of ${laneItems.length}.`,
      );
    });
    const card = document
      .getElementById(`item-title-${itemId}`)
      ?.closest("button");
    card?.focus({ preventScroll: true });
    card?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function navigateWorkflow(event: ReactKeyboardEvent<HTMLDivElement>) {
    const target = event.target;
    const direction = movementKeys[event.key];
    if (
      event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      target instanceof HTMLElement &&
      target.matches(".work-item") &&
      direction
    ) {
      event.preventDefault();
      const itemId = target.dataset.itemId;
      if (
        itemId &&
        store.actions.moveItem({
          itemId,
          direction,
          filters: { query, onlyMine, category },
        })
      ) {
        revealMovedItem(itemId);
      }
      return;
    }
    if (
      event.defaultPrevented ||
      event.altKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      !(target instanceof HTMLElement) ||
      target.isContentEditable ||
      target.closest("input, textarea, select, .inline-item-form") ||
      ![
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;

    const lanes = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(".workflow-lane"),
    );
    const currentLane = target.closest<HTMLElement>(".workflow-lane");
    let laneIndex = currentLane
      ? lanes.indexOf(currentLane)
      : stages.findIndex((stage) => stage.id === mobileStage);
    const currentCards = Array.from(
      lanes[laneIndex].querySelectorAll<HTMLButtonElement>(".work-item"),
    );
    const currentCard = target.closest<HTMLButtonElement>(".work-item");
    const cardIndex = currentCard ? currentCards.indexOf(currentCard) : -1;
    let nextCardIndex = Math.max(cardIndex, 0);

    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      if (currentLane) laneIndex += event.key === "ArrowRight" ? 1 : -1;
      laneIndex = Math.max(0, Math.min(lanes.length - 1, laneIndex));
    } else if (event.key === "Home") {
      nextCardIndex = 0;
    } else if (event.key === "End") {
      nextCardIndex = currentCards.length - 1;
    } else if (event.key === "ArrowDown") {
      nextCardIndex = cardIndex + 1;
    } else {
      nextCardIndex = cardIndex < 0 ? currentCards.length - 1 : cardIndex - 1;
    }

    const nextLane = lanes[laneIndex];
    const nextCards =
      nextLane.querySelectorAll<HTMLButtonElement>(".work-item");
    const nextTarget =
      nextCards[Math.max(0, Math.min(nextCards.length - 1, nextCardIndex))] ??
      nextLane.querySelector<HTMLElement>(".lane-items");
    if (!nextTarget) return;

    event.preventDefault();
    // Keep creation in the active stage, then reveal the focused card by scrolling.
    flushSync(() => setMobileStage(stages[laneIndex].id));
    nextTarget.focus({ preventScroll: true });
    nextTarget.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  return (
    <div className="relay-app">
      <a className="skip-link" href="#workflow">
        Skip to workflow
      </a>
      <aside className="navigation-rail" aria-label="Relay navigation">
        <nav className="rail-links" aria-label="Workspace views">
          <button
            className={`rail-button ${!onlyMine ? "is-active" : ""}`}
            aria-label="All work"
            aria-pressed={!onlyMine}
            title="All work"
            onClick={resetFilters}
          >
            <Icon name="grid" />
          </button>
          <button
            className={`rail-button ${onlyMine ? "is-active" : ""}`}
            aria-label="My work"
            aria-pressed={onlyMine}
            title="My work"
            onClick={() => setOnlyMine(true)}
          >
            <Icon name="person" />
          </button>
          <button
            className="rail-button"
            aria-label="Search work items"
            title="Search work items (/)"
            onClick={() => searchRef.current?.focus()}
          >
            <Icon name="search" />
          </button>
        </nav>
        <div className="rail-bottom">
          <a
            className="rail-button"
            href="/offline"
            aria-label="Cached workspaces"
            title="Cached workspaces"
          >
            <Icon name="hard-drive" />
          </a>
          <Link
            className="rail-button"
            href="/account"
            aria-label="Your account and online workspaces"
            title="Your account and online workspaces"
          >
            <Icon name="cloud" />
          </Link>
          <button
            className="rail-button"
            aria-label="Workspace guide"
            title="Workspace guide (?)"
            onClick={() => setPanel("help")}
          >
            <Icon name="help" />
          </button>
          <span
            className="account-mark"
            title="Your local account"
            aria-label="Your local account"
          >
            Y
          </span>
        </div>
      </aside>

      <div className="workspace-shell">
        <header className="workspace-header">
          <div className="workspace-identity">
            <span className="wordmark">
              relay<span>.</span>
            </span>
            <span className="header-slash" aria-hidden="true">
              /
            </span>
            <span className="workspace-name">{workspace.name}</span>
          </div>
          <div className="workspace-members">
            <WorkspacePresence />
          </div>
          <button
            className="sync-button"
            aria-label="Open Sync Inspector"
            aria-describedby="workspace-sync-status"
            aria-haspopup="dialog"
            aria-expanded={panel === "sync"}
            aria-controls={panel === "sync" ? "sync-inspector" : undefined}
            onClick={() => setPanel("sync")}
          >
            <SyncStatus id="workspace-sync-status" />
            <Icon name="chevron" width="14" height="14" />
          </button>
        </header>

        <main className="workspace-main">
          <section
            className="workspace-intro"
            aria-labelledby="workspace-title"
          >
            <div>
              <h1 id="workspace-title">
                {workspaceEmpty
                  ? "Your workspace starts here"
                  : "Good work moves forward"}
                <span className="heading-period">.</span>
              </h1>
              {workspaceEmpty && (
                <p>Add your first item to any stage. Take it from there.</p>
              )}
            </div>
          </section>

          <div className="workspace-toolbar">
            <div className="view-tabs" aria-label="Filter by ownership">
              <button
                className={!onlyMine ? "is-selected" : ""}
                aria-pressed={!onlyMine}
                onClick={() => setOnlyMine(false)}
              >
                <Icon name="grid" width="15" height="15" />
                All work<span className="tab-count">{items.length}</span>
              </button>
              <button
                className={onlyMine ? "is-selected" : ""}
                aria-pressed={onlyMine}
                onClick={() => setOnlyMine(true)}
              >
                My work
                <span className="tab-count">
                  {items.filter((item) => item.assignee === "You").length}
                </span>
              </button>
            </div>
            <div className="toolbar-actions">
              <div className="search-field">
                <Icon name="search" width="15" height="15" />
                <input
                  ref={searchRef}
                  aria-label="Search items"
                  placeholder="Search items…"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      setQuery("");
                      event.currentTarget.blur();
                    }
                  }}
                />
                {query ? (
                  <button
                    className="clear-search"
                    aria-label="Clear search"
                    onClick={() => setQuery("")}
                  >
                    <Icon name="close" width="13" height="13" />
                  </button>
                ) : (
                  <kbd>/</kbd>
                )}
              </div>
              <label
                className={`category-filter ${category !== "All categories" ? "is-filtered" : ""}`}
              >
                <Icon name="filter" width="15" height="15" />
                <span className="sr-only">Filter by category</span>
                <select
                  aria-label="Filter by category"
                  value={category}
                  onChange={(event) =>
                    setCategory(event.target.value as ItemFilters["category"])
                  }
                >
                  <option>All categories</option>
                  <option>Product</option>
                  <option>Design</option>
                  <option>Engineering</option>
                </select>
              </label>
              <button
                className="primary-button new-item-button"
                onClick={() => openInlineCreate(mobileStage)}
              >
                <Icon name="plus" width="16" height="16" />
                {workspaceEmpty ? "Add first item" : "New item"}
                <kbd>C</kbd>
              </button>
            </div>
          </div>

          <div className="mobile-stage-selector">
            <label htmlFor="mobile-stage">Jump to stage</label>
            <select
              id="mobile-stage"
              value={mobileStage}
              onChange={(event) => {
                const stageId = event.target.value as StageId;
                setMobileStage(stageId);
                document.getElementById(`lane-${stageId}`)?.scrollIntoView({
                  block: "nearest",
                  inline: "start",
                });
              }}
            >
              {board.map(({ stage, items: laneItems }) => (
                <option key={stage.id} value={stage.id}>
                  {stage.name} · {laneItems.length}
                </option>
              ))}
            </select>
          </div>

          {filtered && (
            <div className="filter-summary" role="status">
              <span>
                {visibleItemCount} of {items.length} items
                {visibleItemCount === 0
                  ? " · No items match your filters"
                  : " shown"}
              </span>
              <button onClick={resetFilters}>
                Clear filters
                <Icon name="close" width="12" height="12" />
              </button>
            </div>
          )}

          <p id="workflow-keyboard-help" className="sr-only">
            Use Up and Down arrow keys to navigate items, Left and Right to
            navigate stages, Home and End for the first and last item, and Enter
            to open an item. Drag to move a card, or hold Shift and use arrow
            keys to reorder within a stage or move between stages. On touch
            screens, swipe horizontally to explore stages, or hold a card
            briefly to drag it. Press Escape to cancel a drag.
          </p>
          <p id="stage-rename-help" className="sr-only">
            Double-click a stage title, or focus it and press Enter, to rename
            it. Press Enter or click away to save. Escape cancels. Blank names
            keep the current stage name.
          </p>
          <BoardDrag onMoved={revealMovedItem}>
            {({ activeId, target }) => (
              <div
                className={`workflow-drag-surface ${activeId ? "is-dragging" : ""}`}
              >
                <div className="mobile-drop-targets" aria-hidden={!activeId}>
                  {stages.map((stage) => (
                    <MobileStageTarget key={stage.id} stageId={stage.id} />
                  ))}
                </div>
                <div
                  className="workflow"
                  id="workflow"
                  tabIndex={-1}
                  aria-label="Workflow stages"
                  aria-describedby="workflow-keyboard-help"
                  onKeyDown={navigateWorkflow}
                  onScroll={updateVisibleStage}
                >
                  {board.map(({ stage, items: laneItems, totalItems }) => {
                    return (
                      <DropLane
                        stageId={stage.id}
                        className={`workflow-lane ${target?.stageId === stage.id ? "is-drop-target" : ""}`}
                        key={stage.id}
                      >
                        <header className="lane-header">
                          <div className="lane-heading">
                            <StageMark stage={stage.kind ?? stage.id} />
                            <StageTitle
                              stageId={stage.id}
                              onRenamed={(previous, name) =>
                                setAnnouncement(
                                  `${previous} renamed to ${name}.`,
                                )
                              }
                            />
                            <span
                              className="lane-count"
                              aria-label={
                                filtered
                                  ? `${laneItems.length} of ${totalItems} items shown`
                                  : `${totalItems} items`
                              }
                            >
                              {laneItems.length}
                              {filtered && (
                                <span className="lane-count-total">
                                  /{totalItems}
                                </span>
                              )}
                            </span>
                            <button
                              id={`add-item-${stage.id}`}
                              className="lane-add icon-button"
                              aria-label={`Add item to ${stage.name}`}
                              title={`Add item to ${stage.name}`}
                              onClick={() => openInlineCreate(stage.id)}
                            >
                              <Icon name="plus" width="15" height="15" />
                            </button>
                          </div>
                          <p>{stage.description}</p>
                        </header>
                        <div
                          className="lane-items"
                          role="region"
                          aria-label={`${stage.name} items`}
                          aria-describedby="workflow-keyboard-help"
                          tabIndex={0}
                        >
                          <DropList stageId={stage.id}>
                            <ul className="lane-list">
                              {laneItems.map((item) => (
                                <li
                                  key={item.id}
                                  className={
                                    target?.stageId === stage.id &&
                                    target.beforeItemId === item.id
                                      ? "drop-before"
                                      : undefined
                                  }
                                >
                                  <DraggableItem itemId={item.id} />
                                </li>
                              ))}
                              <li
                                className={`lane-drop-end ${target?.stageId === stage.id && target.beforeItemId === null ? "drop-before" : ""}`}
                                aria-hidden="true"
                              />
                            </ul>
                            {laneItems.length === 0 && (
                              <div className="empty-lane">
                                <span
                                  className="empty-line"
                                  aria-hidden="true"
                                />
                                <p>
                                  {totalItems > 0
                                    ? "No matching items"
                                    : "No items yet"}
                                </p>
                              </div>
                            )}
                          </DropList>
                        </div>
                        <InlineItemCreator
                          stageId={stage.id}
                          active={creationStage === stage.id}
                          inputRef={creationInputRef}
                          onStart={() => openInlineCreate(stage.id)}
                          onCancel={cancelCreating}
                          onCreated={revealCreatedItem}
                        />
                      </DropLane>
                    );
                  })}
                </div>
              </div>
            )}
          </BoardDrag>

          <div className="workspace-bottom-note">
            <span className="keyboard-hint">
              <kbd>↑↓←→</kbd> to navigate<span className="hint-divider">·</span>
              <kbd>Shift + arrows</kbd> to move
            </span>
          </div>
        </main>

        <footer className="workspace-footer">
          <span className="footer-session">
            <Icon name="monitor" width="14" height="14" />
            Cached workspace
            <span className="footer-separator">/</span>
            <span>
              {state.storageError
                ? "Local changes not saved"
                : state.unsavedOperationCount > 0
                  ? "Saving locally..."
                  : "Changes saved on this device"}
            </span>
          </span>
          <button
            className="state-path"
            onClick={() => setPanel("sync")}
            aria-label="Inspect local and server connection"
            aria-haspopup="dialog"
            aria-expanded={panel === "sync"}
            aria-controls={panel === "sync" ? "sync-inspector" : undefined}
          >
            <span>LOCAL</span>
            <span className="path-line">
              <i />
            </span>
            <span className="path-break">×</span>
            <span className="server-label">SERVER</span>
          </button>
        </footer>
      </div>

      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {selectedItem && (
        <ItemEditor
          onStageChange={(stageId) => {
            setMobileStage(stageId);
            const next = store.getSnapshot();
            const item = selectSelectedItem(next);
            setAnnouncement(
              `${item?.title.trim() || "Untitled item"} moved to ${next.stages[stageId].name}.`,
            );
          }}
          onClose={closeItemEditor}
        />
      )}
      {panel === "sync" && (
        <SyncInspector onClose={() => setPanel(null)}>
          {process.env.NODE_ENV === "development" && <SyncStatusPreview />}
        </SyncInspector>
      )}
      {panel === "help" && (
        <Panel title="Workspace guide" onClose={() => setPanel(null)}>
          <div className="panel-body">
            <p className="eyebrow">WELCOME TO RELAY</p>
            <h2 className="panel-title">One shared path forward.</h2>
            <p className="panel-description">
              Capture an idea, give it a plan, and follow it through to shipped.
              Each column is a stage of the same workflow.
            </p>
            <ol className="guide-stages">
              {stages.map((stage) => (
                <li key={stage.id}>
                  <StageMark stage={stage.kind ?? stage.id} />
                  <strong>{stage.name}</strong>
                  <span>{stage.description}</span>
                </li>
              ))}
            </ol>
            <p className="panel-description">
              Open any item to edit its details or change its stage. Use My work
              to focus on items assigned to you. To add an item, choose Add item
              in a column, type a title, and press Enter. Press Escape to
              cancel. Double-click a stage title to rename it, then press Enter
              to save or Escape to cancel.
            </p>
            <dl className="inspector-ledger">
              <div>
                <dt>Navigate items / stages</dt>
                <dd>
                  <kbd>↑</kbd> <kbd>↓</kbd> / <kbd>←</kbd> <kbd>→</kbd>
                </dd>
              </div>
              <div>
                <dt>First / last item in a stage</dt>
                <dd>
                  <kbd>Home</kbd> / <kbd>End</kbd>
                </dd>
              </div>
              <div>
                <dt>Open the focused item</dt>
                <dd>
                  <kbd>Enter</kbd>
                </dd>
              </div>
              <div>
                <dt>Move an item / change stage</dt>
                <dd>
                  <kbd>Shift</kbd> + arrow keys
                </dd>
              </div>
              <div>
                <dt>Create an item</dt>
                <dd>
                  <kbd>C</kbd>
                </dd>
              </div>
              <div>
                <dt>Search the workspace</dt>
                <dd>
                  <kbd>/</kbd>
                </dd>
              </div>
              <div>
                <dt>Close a panel</dt>
                <dd>
                  <kbd>Esc</kbd>
                </dd>
              </div>
            </dl>
            <p className="session-note">
              This workspace is stored on this device. You can keep editing
              offline.
            </p>
          </div>
        </Panel>
      )}
    </div>
  );
}
