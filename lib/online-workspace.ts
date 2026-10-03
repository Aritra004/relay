// HTTP contracts only. No database or provider implementation reaches React.
export interface AccountUser { id: string; name: string; email: string }
export interface OnlineWorkspace {
  id: string; name: string; version: number; createdAt: string; updatedAt: string;
}
export interface WorkspaceSummary extends OnlineWorkspace { role: "owner" | "member" }
export interface OnlineSnapshot {
  workspace: OnlineWorkspace;
  version: number;
  stages: { id: string; name: string; description: string; position: number }[];
  items: { id: string; title: string; description: string; stageId: string; position: number; version: number; updatedAt: string }[];
  members: { userId: string; name: string; role: "owner" | "member"; joinedAt: string }[];
  membership: { userId: string; role: "owner" | "member" };
  stageOrder: string[];
  itemOrderByStage: Record<string, string[]>;
}

export class WorkspaceApiError extends Error {
  readonly kind: "unavailable" | "unauthenticated" | "forbidden" | "invalid-response" | "request";
  readonly status?: number;
  constructor(kind: WorkspaceApiError["kind"], message: string, status?: number) {
    super(message);
    this.name = "WorkspaceApiError";
    this.kind = kind;
    this.status = status;
  }
}

export async function fetchApi<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init, cache: "no-store", credentials: "same-origin",
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    });
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    throw new WorkspaceApiError("unavailable", "Cannot reach the server. Your local work is preserved.");
  }
  if (response.status === 401) throw new WorkspaceApiError("unauthenticated", "Your session has expired or was rejected. Sign in again.", 401);
  if (response.status === 403 || response.status === 404) throw new WorkspaceApiError("forbidden", "Workspace access was rejected. Your local changes are preserved.", response.status);
  if (response.status >= 500 || response.status === 408 || response.status === 429) {
    throw new WorkspaceApiError("unavailable", "The server is temporarily unavailable. Your local work is preserved.", response.status);
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new WorkspaceApiError("invalid-response", "The server returned an unreadable response. Local data was preserved."); }
  if (!response.ok) throw new WorkspaceApiError("request", "The request was rejected. Check the workspace name and try again.", response.status);
  return body as T;
}

export const workspaceApi = Object.freeze({
  session: (signal?: AbortSignal) => fetchApi<{ user: AccountUser }>("/api/session", { signal }),
  list: (signal?: AbortSignal) => fetchApi<{ workspaces: WorkspaceSummary[] }>("/api/workspaces", { signal }),
  create: (name: string, signal?: AbortSignal) => fetchApi<{ workspace: OnlineWorkspace }>("/api/workspaces", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }), signal,
  }),
  snapshot: (workspaceId: string, signal?: AbortSignal) => fetchApi<OnlineSnapshot>(`/api/workspaces/${encodeURIComponent(workspaceId)}`, { signal }),
});
