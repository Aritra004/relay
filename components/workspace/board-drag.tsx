import { useRef, useState, type ReactNode } from "react";
import {
  DndContext,
  DragOverlay,
  MouseSensor,
  TouchSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragMoveEvent,
} from "@dnd-kit/core";
import type { StageId, WorkItem } from "./workspace-data";
import type { ItemMove } from "./item-movement";
import { selectItems, selectStages } from "./workspace-store";
import { useWorkspaceSelector, useWorkspaceStore } from "./workspace-provider";
import { RemoteChangeLabel } from "./remote-change";

type DropTarget = Omit<ItemMove, "itemId">;

export function BoardDrag({
  onMoved,
  children,
}: {
  onMoved: (itemId: string) => void;
  children: (state: {
    activeId: string | null;
    target: DropTarget | null;
  }) => ReactNode;
}) {
  const { actions } = useWorkspaceStore();
  const state = useWorkspaceSelector((snapshot) => snapshot);
  const items = selectItems(state);
  const stages = selectStages(state);
  // Transient drag feedback only. A drop commits through the central store;
  // canceling or unmounting this component cannot change card membership/order.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [target, setTarget] = useState<DropTarget | null>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 220, tolerance: 8 },
    }),
  );
  const activeItem = items.find((item) => item.id === activeId);

  function destination(event: DragMoveEvent): DropTarget | null {
    const stageId = event.over?.data.current?.stageId as StageId | undefined;
    if (!stageId) return null;
    if (event.over?.data.current?.append)
      return { stageId, beforeItemId: null };

    const lane = document.getElementById(`lane-${stageId}`);
    const cards = Array.from(
      lane?.querySelectorAll<HTMLElement>(".work-item") ?? [],
    );
    // Viewport coordinates remain accurate while a scroll container moves.
    const pointerY = pointer.current?.y;
    if (pointerY === undefined) return null;
    const nextCard = cards.find((card) => {
      if (card.dataset.itemId === event.active.id) return false;
      const bounds = card.getBoundingClientRect();
      return pointerY < bounds.top + bounds.height / 2;
    });
    return { stageId, beforeItemId: nextCard?.dataset.itemId ?? null };
  }

  function preview(event: DragMoveEvent) {
    const next = destination(event);
    setTarget((current) =>
      current?.stageId === next?.stageId &&
      current?.beforeItemId === next?.beforeItemId
        ? current
        : next,
    );
  }

  function finish() {
    setActiveId(null);
    setTarget(null);
  }

  return (
    <DndContext
      id="workflow-drag"
      sensors={sensors}
      collisionDetection={(args) => {
        pointer.current = args.pointerCoordinates;
        const boardBounds = document
          .getElementById("workflow")
          ?.getBoundingClientRect();
        const hits = pointerWithin(args).filter(({ id }) => {
          // Keep the mobile shortcuts usable, but clip lane targets to the board.
          if (String(id).startsWith("mobile:")) return true;
          const point = args.pointerCoordinates;
          if (
            !point ||
            !boardBounds ||
            point.x < boardBounds.left ||
            point.x > boardBounds.right ||
            point.y < boardBounds.top ||
            point.y > boardBounds.bottom
          )
            return false;
          if (!String(id).startsWith("list:")) return true;
          const list = args.droppableContainers.find((entry) => entry.id === id)
            ?.node.current;
          const bounds = list?.parentElement?.getBoundingClientRect();
          // A scrolled list must not accept drops through its clipped edges.
          return (
            bounds &&
            point &&
            point.x >= bounds.left &&
            point.x <= bounds.right &&
            point.y >= bounds.top &&
            point.y <= bounds.bottom
          );
        });
        // The list's scrollable parent lets dnd-kit scroll the hovered lane.
        return hits.sort(
          (a, b) =>
            Number(String(b.id).startsWith("list:")) -
            Number(String(a.id).startsWith("list:")),
        );
      }}
      accessibility={{
        restoreFocus: false,
        screenReaderInstructions: {
          draggable:
            "Drag to move this item. Hold Shift and use arrow keys to reorder or change stages. Enter opens its details.",
        },
        announcements: {
          onDragStart: ({ active }) =>
            `Picked up ${items.find((item) => item.id === active.id)?.title || "Untitled item"}. Escape cancels.`,
          onDragOver: ({ over }) =>
            over
              ? `Over ${stages.find((stage) => stage.id === over.data.current?.stageId)?.name}.`
              : "Outside the workflow. Release to cancel.",
          onDragEnd: ({ over }) => (over ? "Item dropped." : "Move canceled."),
          onDragCancel: () => "Move canceled. Item unchanged.",
        },
      }}
      onDragStart={({ active }) => setActiveId(String(active.id))}
      onDragMove={preview}
      onDragOver={preview}
      onDragCancel={finish}
      onDragEnd={(event) => {
        const next = destination(event);
        const itemId = String(event.active.id);
        if (next && actions.moveItem({ itemId, ...next })) onMoved(itemId);
        finish();
      }}
    >
      {children({ activeId, target })}
      <DragOverlay dropAnimation={null}>
        {activeItem && (
          <div className="work-item drag-preview" aria-hidden="true">
            <ItemContent item={activeItem} preview />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

export function DropLane({
  stageId,
  className,
  children,
}: {
  stageId: StageId;
  className: string;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: `lane:${stageId}`,
    data: { stageId },
  });
  return (
    <section
      ref={setNodeRef}
      id={`lane-${stageId}`}
      className={className}
      aria-labelledby={`stage-${stageId}`}
    >
      {children}
    </section>
  );
}

export function DropList({
  stageId,
  children,
}: {
  stageId: StageId;
  children: ReactNode;
}) {
  const { setNodeRef } = useDroppable({
    id: `list:${stageId}`,
    data: { stageId },
  });
  return (
    <div ref={setNodeRef} className="lane-drop-area">
      {children}
    </div>
  );
}

export function MobileStageTarget({ stageId }: { stageId: StageId }) {
  const stageName = useWorkspaceSelector((state) => state.stages[stageId].name);
  const { setNodeRef, isOver } = useDroppable({
    id: `mobile:${stageId}`,
    data: { stageId, append: true },
  });
  return (
    <div
      ref={setNodeRef}
      className={`mobile-drop-stage ${isOver ? "is-over" : ""}`}
      title={stageName}
    >
      <span>{stageName}</span>
    </div>
  );
}

export function DraggableItem({ itemId }: { itemId: string }) {
  const { selectItem } = useWorkspaceStore();
  const item = useWorkspaceSelector((state) => state.items[itemId]);
  const conflicted = useWorkspaceSelector((state) =>
    state.syncMetadata.conflicts?.some(
      (c) =>
        c.status === "unresolved" &&
        c.entityType === "item" &&
        c.entityId === itemId,
    ),
  );
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: itemId,
    disabled: conflicted,
  });
  if (!item) return null;
  return (
    <button
      ref={setNodeRef}
      {...attributes}
      {...listeners}
      aria-disabled={false}
      className={`work-item ${isDragging ? "is-dragging" : ""} ${conflicted ? "has-conflict" : ""}`}
      data-item-id={item.id}
      aria-labelledby={`item-title-${item.id}`}
      aria-describedby={`${attributes["aria-describedby"]} workflow-keyboard-help${item.changed ? ` item-status-${item.id}` : ""}`}
      onClick={() => selectItem(itemId)}
    >
      <ItemContent item={item} />
      <RemoteChangeLabel entityId={item.id} />
      {conflicted && (
        <span className="conflict-badge">
          <span aria-hidden="true">!</span> Conflict
        </span>
      )}
    </button>
  );
}

function ItemContent({
  item,
  preview = false,
}: {
  item: WorkItem;
  preview?: boolean;
}) {
  return (
    <>
      <span
        className="item-title"
        id={preview ? undefined : `item-title-${item.id}`}
        title={item.title.trim() || "Untitled item"}
      >
        {item.title.trim() || "Untitled item"}
      </span>
      <span
        className={`item-description${item.description.trim() ? "" : " item-description--empty"}`}
      >
        {item.description.trim() ? item.description : "No description"}
      </span>
      {item.changed && (
        <span
          className="local-edit-label"
          id={preview ? undefined : `item-status-${item.id}`}
        >
          <span aria-hidden="true">◐</span> Local edit
        </span>
      )}
    </>
  );
}
