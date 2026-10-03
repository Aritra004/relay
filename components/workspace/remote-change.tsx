import { useEffect, useState } from "react";
import { useWorkspaceSelector } from "./workspace-provider";

export function RemoteChangeLabel({ entityId }: { entityId: string }) {
  const change = useWorkspaceSelector((state) => state.remoteChanges[entityId]);
  const [expired, setExpired] = useState<string | null>(null);
  useEffect(() => {
    if (!change) return;
    const timer = setTimeout(
      () => setExpired(change.operationId),
      Math.max(0, change.timestamp + 4500 - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [change]);
  if (!change || expired === change.operationId) return null;
  return (
    <span key={change.operationId} className="remote-change-label">
      {change.type === "MOVE_ITEM" ? "Moved remotely" : "Updated remotely"}
    </span>
  );
}
