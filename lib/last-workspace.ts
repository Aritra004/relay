// A device preference for reopening a workspace at "/". It is never a session
// credential or a permission; the workspace page still verifies access itself.
const STORAGE_KEY = "relay.last-opened-workspace";
const UUID = /^[0-9a-f-]{36}$/i;

export interface LastOpenedWorkspace {
  readonly workspaceId: string;
  readonly userId: string;
}

export function readLastOpenedWorkspace(): LastOpenedWorkspace | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const { workspaceId, userId } = value as Record<string, unknown>;
    if (typeof workspaceId !== "string" || !UUID.test(workspaceId)) return null;
    if (typeof userId !== "string" || !UUID.test(userId)) return null;
    return { workspaceId, userId };
  } catch {
    // Blocked or corrupt preference storage never affects workspace data.
    return null;
  }
}

export function rememberLastOpenedWorkspace(record: LastOpenedWorkspace) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
  } catch {
    /* A read-only preference store only loses the shortcut, not any work. */
  }
}
