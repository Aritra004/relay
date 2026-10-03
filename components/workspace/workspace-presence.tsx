import { useWorkspaceSelector } from "./workspace-provider";

export function WorkspacePresence() {
  const presence = useWorkspaceSelector((s) => s.presence);
  const items = useWorkspaceSelector((s) => s.items);
  const self = useWorkspaceSelector((s) => s.workspace.cachedForUserId);
  const online = presence.members.filter((m) => m.status === "online");
  return <div className="workspace-presence" aria-label="Workspace presence">
    <div className="presence-avatars">
      {online.slice(0, 6).map((m) => <span key={m.userId} className="presence-avatar" title={`${m.displayName} · Online`} aria-label={`${m.displayName} online`}>{m.avatar || "?"}<i /></span>)}
    </div>
    <span role="status">{online.length} online</span>
    {online.filter((m) => m.userId !== self && m.editingItemId && items[m.editingItemId]).slice(0, 1).map((m) => <span className="presence-editing-summary" key={m.userId} role="status">{m.displayName} is editing “{items[m.editingItemId!].title}”</span>)}
  </div>;
}

export function EditingPresence({ itemId }: { itemId: string }) {
  const members = useWorkspaceSelector((s) => s.presence.members);
  const self = useWorkspaceSelector((s) => s.workspace.cachedForUserId);
  const editors = members.filter((m) => m.userId !== self && m.status === "online" && m.editingItemId === itemId);
  if (!editors.length) return null;
  return <p className="editing-presence" role="status">{editors.map((m) => m.displayName).join(", ")} {editors.length === 1 ? "is" : "are"} editing this item</p>;
}
