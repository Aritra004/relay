import { useEffect, useRef, type ReactNode } from "react";
import { Icon } from "./icons";

export function Panel({
  title,
  onClose,
  children,
  variant = "drawer",
  id,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  variant?: "drawer" | "compact";
  id?: string;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement;
    dialog?.showModal();
    return () => {
      dialog?.close();
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialogRef}
      id={id}
      className={`detail-panel${variant === "compact" ? " detail-panel--compact" : ""}`}
      aria-labelledby="panel-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          const bounds = event.currentTarget.getBoundingClientRect();
          if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
          )
            onClose();
        }
      }}
    >
      <header className="panel-header">
        <span id="panel-title">{title}</span>
        <button
          className="icon-button"
          onClick={onClose}
          aria-label="Close panel"
        >
          <Icon name="close" />
        </button>
      </header>
      {children}
    </dialog>
  );
}
