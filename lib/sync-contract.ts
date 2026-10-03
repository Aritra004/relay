import { z } from "zod";
import { operationSchema } from "./operation-contract.ts";

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const remoteOperationSchema = z.strictObject({
  operation: operationSchema,
  authorId: z.uuid(),
  serverVersion: version.min(1),
  entityVersion: version.min(1),
});
export type RemoteOperation = z.infer<typeof remoteOperationSchema>;
export const historySchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ok"), workspaceId: z.uuid(),
    startingVersion: version, endingVersion: version, currentWorkspaceVersion: version,
    operations: z.array(remoteOperationSchema).max(500), hasMore: z.boolean(),
  }),
  z.strictObject({
    status: z.literal("snapshot-required"), workspaceId: z.uuid(),
    currentWorkspaceVersion: version,
    reason: z.literal("OPERATION_HISTORY_UNAVAILABLE"),
  }),
]);
export type OperationHistory = z.infer<typeof historySchema>;

export type SyncPhase = "idle" | "offline" | "checking" | "pulling" | "applying-remote" |
  "pushing-local" | "synced" | "conflict" | "error";
export const syncPhaseLabels: Record<SyncPhase, string> = {
  idle: "Waiting to synchronize", offline: "Offline", checking: "Checking server changes",
  pulling: "Pulling remote changes", "applying-remote": "Applying remote changes",
  "pushing-local": "Uploading local changes", synced: "Synced",
  conflict: "Conflict needs attention", error: "Sync needs attention",
};

// Explicit legal transitions. Reconnect/retry starts a new check; only a complete
// pull with an empty durable queue can enter synced.
const transitions: Record<SyncPhase, readonly SyncPhase[]> = {
  idle: ["checking", "offline", "error", "conflict"],
  offline: ["idle", "checking", "error", "conflict"],
  checking: ["pulling", "applying-remote", "synced", "idle", "offline", "error", "conflict"],
  pulling: ["applying-remote", "pushing-local", "synced", "idle", "offline", "error", "conflict"],
  "applying-remote": ["pulling", "pushing-local", "synced", "idle", "offline", "error", "conflict"],
  "pushing-local": ["pulling", "idle", "offline", "error", "conflict"],
  synced: ["idle", "checking", "offline", "error", "conflict"],
  conflict: ["checking", "idle", "offline", "error"],
  error: ["checking", "idle", "offline", "conflict"],
};
export function transitionSyncPhase(from: SyncPhase, to: SyncPhase): SyncPhase {
  if (from !== to && !transitions[from].includes(to)) throw new Error(`Invalid sync transition: ${from} -> ${to}`);
  return to;
}

export interface SyncConflict {
  operationId: string;
  remoteOperation?: RemoteOperation;
  reason: string;
}
