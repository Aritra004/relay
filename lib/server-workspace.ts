import {
  createWorkspaceStore,
  type WorkspaceStore,
} from "../components/workspace/workspace-store.ts";
import {
  accountRegistry,
  accountWorkspaceRepository,
  AccountChangedError,
  type AccountRegistry,
  type LocalAccount,
} from "./local-account.ts";
import { workspaceApi, WorkspaceApiError } from "./online-workspace.ts";
import { toLocalSnapshot } from "./server-snapshot.ts";
import type {
  WorkspaceRepository,
  SavedWorkspace,
} from "./workspace-repository.ts";

export interface ServerWorkspaceState {
  readonly store: WorkspaceStore | null;
  readonly access:
    | "checking"
    | "online"
    | "unavailable"
    | "unauthenticated"
    | "forbidden"
    | "error";
  readonly message: string;
  readonly source: "cache" | "server" | null;
}

// Coordinates loading and access. The provider runs the durable operation uploader.
export function createServerWorkspace(
  workspaceId: string,
  {
    api = workspaceApi,
    accounts = accountRegistry,
    repositoryFor = accountWorkspaceRepository,
  }: {
    api?: Pick<typeof workspaceApi, "session" | "snapshot">;
    accounts?: AccountRegistry;
    repositoryFor?: (userId: string) => WorkspaceRepository;
  } = {},
) {
  const initial: ServerWorkspaceState = {
    store: null,
    access: "checking",
    message: "Opening workspace…",
    source: null,
  };
  let state = initial;
  let owner: string | undefined;
  let repository: WorkspaceRepository | undefined;
  let generation: string | null = null;
  let connection = true;
  let request: AbortController | undefined;
  let initializing: Promise<void> | undefined;
  let refreshing: Promise<void> | undefined;
  let retryAfterAbort = false;
  const listeners = new Set<() => void>();
  const publish = (next: Partial<ServerWorkspaceState>) => {
    state = { ...state, ...next };
    listeners.forEach((listener) => listener());
  };
  const accessBlocked = () =>
    state.access === "unauthenticated" ||
    state.access === "forbidden" ||
    state.store?.getSnapshot().editingBlocked;
  function block(
    access: "unauthenticated" | "forbidden" | "error",
    message: string,
  ) {
    state.store?.setEditingBlocked(true);
    publish({ access, message });
  }
  async function show(saved: SavedWorkspace, source: "cache" | "server") {
    if (
      saved.workspace.source !== "server" ||
      saved.workspace.cachedForUserId !== owner ||
      !saved.syncMetadata
    ) {
      throw new Error("The cached workspace does not belong to this account.");
    }
    if (state.store) return;
    const store = createWorkspaceStore({ savedWorkspace: saved, repository });
    await store.persistence.initialize();
    const account = await accounts.read();
    if (
      account?.status !== "active" ||
      account.user?.id !== owner ||
      account.generation !== generation
    )
      throw new AccountChangedError();
    store.setOnline(connection);
    publish({ store, source });
    if (saved.syncMetadata.serverAccess === "forbidden")
      block(
        "forbidden",
        "Workspace access was rejected. Local changes are preserved.",
      );
  }
  async function ensureAccountUnchanged(signal: AbortSignal) {
    const current = await accounts.read();
    if (signal.aborted || (current?.generation ?? null) !== generation)
      throw new AccountChangedError();
  }
  function refresh(): Promise<void> {
    if (refreshing) return refreshing;
    if (!connection) {
      if (
        !["unauthenticated", "forbidden", "error"].includes(state.access) &&
        !state.store?.getSnapshot().editingBlocked
      )
        publish({
          access: "unavailable",
          message:
            "Offline. You can keep editing this device’s cached workspace.",
        });
      return Promise.resolve();
    }
    request = new AbortController();
    const signal = request.signal;
    if (!accessBlocked())
      publish({ access: "checking", message: "Checking workspace access…" });
    refreshing = (async () => {
      try {
        const current = await accounts.read();
        generation = current?.generation ?? null;
        const { user } = await api.session(signal);
        await ensureAccountUnchanged(signal);
        const account = await accounts.remember(user, generation);
        generation = account.generation;
        if (owner && owner !== user.id) {
          block(
            "unauthenticated",
            "The active account changed. Reopen this workspace from your account.",
          );
          return;
        }
        owner = user.id;
        repository = repositoryFor(user.id);
        const remote = await api.snapshot(workspaceId, signal);
        await ensureAccountUnchanged(signal);
        const snapshot = toLocalSnapshot(remote, workspaceId, user.id);
        // Never hydrate over a live store, including an edit still being saved.
        // The repository also protects caches initialized by another tab.
        if (!state.store) {
          const saved = await repository.initializeServerWorkspace(snapshot);
          await ensureAccountUnchanged(signal);
          await show(saved, "server");
        }
        await repository.setServerAccess(workspaceId, "authorized");
        await ensureAccountUnchanged(signal);
        state.store?.setEditingBlocked(false);
        publish({
          access: "online",
          message:
            "Changes save locally. Sync pulls collaborator updates before uploading your pending changes.",
        });
      } catch (error) {
        if (signal.aborted) return;
        if (error instanceof AccountChangedError) {
          block("unauthenticated", error.message);
        } else if (
          error instanceof WorkspaceApiError &&
          error.kind === "unauthenticated"
        ) {
          await accounts.expire(generation).catch(() => {});
          block("unauthenticated", error.message);
        } else if (
          error instanceof WorkspaceApiError &&
          error.kind === "forbidden"
        ) {
          await repository?.setServerAccess(workspaceId, "forbidden");
          block("forbidden", error.message);
        } else if (
          error instanceof WorkspaceApiError &&
          error.kind === "unavailable"
        ) {
          // An outage never converts an explicit denial into permission.
          if (!accessBlocked())
            publish({ access: "unavailable", message: error.message });
        } else {
          publish({
            access: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unable to open the workspace. Local data was preserved.",
          });
        }
      }
    })().finally(() => {
      refreshing = undefined;
      if (retryAfterAbort && connection) {
        retryAfterAbort = false;
        void refresh();
      }
    });
    return refreshing;
  }
  async function initialize(online: boolean) {
    connection = online;
    if (initializing) return initializing;
    initializing = (async () => {
      try {
        const account = await accounts.read();
        generation = account?.generation ?? null;
        if (account?.status === "active" && account.user) {
          owner = account.user.id;
          repository = repositoryFor(owner);
          const saved = await repository.getWorkspace(workspaceId);
          if (saved) await show(saved, "cache");
        } else if (
          account?.status === "expired" ||
          account?.status === "signed-out"
        ) {
          block(
            "unauthenticated",
            "Sign in to open your cached workspaces. Local changes are preserved.",
          );
        }
        await refresh();
      } catch (error) {
        block(
          "error",
          error instanceof Error
            ? error.message
            : "Unable to read local storage.",
        );
      }
    })();
    return initializing;
  }
  function accountChanged(account: LocalAccount | undefined) {
    if (!owner) return;
    if (account?.status !== "active" || account.user?.id !== owner) {
      request?.abort();
      block(
        "unauthenticated",
        "Your account changed or signed out. Sign in again to open this workspace. Local work is preserved.",
      );
    }
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    initialize,
    refresh,
    async exportRecovery() {
      if (!repository) throw new Error("No cached workspace is available.");
      return repository.exportRecovery(workspaceId);
    },
    async recover() {
      if (!owner || !repository || state.store) return;
      if (!connection) {
        block("error", "Reconnect to rebuild the cached board. Your local records are preserved and can still be downloaded.");
        return;
      }
      publish({ access: "checking", message: "Recovering the cached board; preserving local work…" });
      try {
        const accountId = owner;
        const account = await accounts.read();
        const { user } = await api.session();
        if (user.id !== accountId || account?.status !== "active" || account.user?.id !== accountId) throw new AccountChangedError();
        const fresh = toLocalSnapshot(await api.snapshot(workspaceId), workspaceId, accountId);
        const current = await accounts.read();
        if (current?.generation !== account.generation) throw new AccountChangedError();
        const saved = await repository.recoverServerWorkspace(fresh);
        await show(saved, "server");
        publish({ access: "online", message: saved.syncMetadata!.recoveryMessage! });
      } catch (error) {
        block("error", error instanceof Error ? error.message : "Recovery could not safely proceed. Download the preserved local records.");
      }
    },
    watchAccount: () =>
      accounts.subscribe(accountChanged, () =>
        block(
          "error",
          "Unable to verify the local account. Local work is preserved.",
        ),
      ),
    setOnline(online: boolean) {
      connection = online;
      state.store?.setOnline(online);
      if (!online) request?.abort();
      if (
        !state.store?.getSnapshot().editingBlocked &&
        !online &&
        !["unauthenticated", "forbidden", "error"].includes(state.access)
      )
        publish({
          access: "unavailable",
          message:
            "Offline. You can keep editing this device’s cached workspace.",
        });
      if (online) {
        if (refreshing && request?.signal.aborted) retryAfterAbort = true;
        else void refresh();
      }
    },
  };
}
