import { Dexie, liveQuery, type Table } from "dexie";
import type { AccountUser } from "./online-workspace.ts";
import { RelayDatabase } from "./local-db.ts";
import { createWorkspaceRepository } from "./workspace-repository.ts";

export interface LocalAccount {
  key: "current";
  user: AccountUser | null;
  status: "active" | "signed-out" | "expired";
  generation: string;
}

// An account hint for opening previously authorized local data, never a session
// credential or permission to synchronize. Separate from the demo database.
export class AccountDatabase extends Dexie {
  declare state: Table<LocalAccount, string>;
  constructor(name = "relay-accounts") {
    super(name);
    this.version(1).stores({ state: "key" });
  }
}

export class AccountChangedError extends Error {
  constructor() { super("The active account changed. Reopen the workspace."); }
}

export function createAccountRegistry(database = new AccountDatabase()) {
  const read = () => database.state.get("current");
  async function change(user: AccountUser | null, status: LocalAccount["status"], expected?: string | null) {
    return database.transaction("rw", database.state, async () => {
      const current = await read();
      if (expected !== undefined && (current?.generation ?? null) !== expected) throw new AccountChangedError();
      if (current?.user?.id === user?.id && current?.status === status) return current;
      const next: LocalAccount = { key: "current", user, status, generation: crypto.randomUUID() };
      await database.state.put(next);
      return next;
    });
  }
  return {
    read,
    remember: (user: AccountUser, expected?: string | null) => change(user, "active", expected),
    signOut: () => change(null, "signed-out"),
    async expire(expected: string | null) {
      const current = await read();
      return change(current?.user ?? null, "expired", expected);
    },
    subscribe(onChange: (account: LocalAccount | undefined) => void, onError: (error: unknown) => void) {
      const subscription = liveQuery(read).subscribe({ next: onChange, error: onError });
      return () => subscription.unsubscribe();
    },
  };
}

export type AccountRegistry = ReturnType<typeof createAccountRegistry>;
export const accountRegistry = createAccountRegistry();
const repositories = new Map<string, ReturnType<typeof createWorkspaceRepository>>();

export function accountWorkspaceRepository(userId: string) {
  // Namespacing avoids mixing two users' pending operations on a shared device.
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error("Invalid cached account identity.");
  let repository = repositories.get(userId);
  if (!repository) {
    const db = new RelayDatabase(`relay-account-${userId}`);
    repository = createWorkspaceRepository(async () => { await db.open(); return db; });
    repositories.set(userId, repository);
  }
  return repository;
}
