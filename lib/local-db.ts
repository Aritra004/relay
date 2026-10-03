import { Dexie, type Table } from "dexie";
import type {
  WorkItem,
  WorkflowStage,
  WorkspaceData,
  WorkspaceDetails,
} from "../components/workspace/workspace-data.ts";
import type { Operation } from "../components/workspace/workspace-operations.ts";
import type { WorkspaceSnapshot } from "./workspace-repository.ts";
import type { RemoteOperation, SyncConflict } from "./sync-contract.ts";
import type { ConflictRecord } from "./conflict-contract.ts";
import type {
  OperationFailure,
  RecentAcknowledgment,
} from "./operation-contract.ts";

export const LOCAL_DATABASE_NAME = "relay";

// Keep the domain's ID-based ordering instead of introducing a second position
// model. Entity records live in their own tables, never nested in a workspace.
export interface StoredWorkspace
  extends
    WorkspaceDetails,
    Pick<WorkspaceData, "stageOrder" | "itemOrderByStage"> {}

export interface StoredWorkflowStage extends WorkflowStage {
  readonly workspaceId: WorkspaceDetails["id"];
}

export interface StoredWorkItem extends WorkItem {
  readonly workspaceId: WorkspaceDetails["id"];
}

// Preserve the operation union and its payloads. The queue writer will assign a
// sequence within each workspace to retain enqueue order, even if clocks change.
// This local order is not a server revision or a conflict-resolution rule.
export type PendingOperation = Operation & { readonly sequence: number };

export interface WorkspaceSyncMetadata {
  readonly recoveryMessage?: string;
  readonly workspaceId: WorkspaceDetails["id"];
  // Number of committed local edits, independent of server acknowledgement.
  readonly localRevision: number;
  // Rotated by recovery or a development reset to reject stale tab writes.
  // Optional for databases created before development reset was introduced.
  readonly localGeneration?: string;
  // Highest workspace version confirmed by a snapshot or our own acknowledgment.
  // This is NOT a cursor proving all preceding remote operations were downloaded.
  readonly lastServerVersion: number | null;
  // Contiguous history fully incorporated into confirmedWorkspaces. Never an
  // upload high-water mark. Undefined on legacy caches until snapshot recovery.
  readonly confirmedServerVersion?: number | null;
  readonly currentServerVersion?: number;
  readonly receivedRemoteOperations?: number;
  readonly recentRemoteOperations?: readonly RemoteOperation[];
  readonly syncConflict?: SyncConflict | null;
  readonly conflicts?: readonly ConflictRecord[];
  // Frozen before the first request so retries never change an idempotent body.
  readonly submittedOperation?: Operation | null;
  readonly acceptedSubmission?:
    import("./operation-contract.ts").OperationAcknowledgment | null;
  // UTC ISO 8601 time of the last successful sync; null before the first sync.
  readonly lastSyncedAt: string | null;
  // Snapshot retrieval is not synchronization/acknowledgement of local edits.
  readonly lastSnapshotAt?: string;
  readonly serverAccess?: "authorized" | "forbidden";
  readonly uploadFailure?: OperationFailure | null;
  readonly recentAcknowledgments?: readonly RecentAcknowledgment[];
}

export class RelayDatabase extends Dexie {
  declare recoveryBackups: Table<{ id: string; workspaceId: string; createdAt: string; data: unknown }, string>;
  declare confirmedWorkspaces: Table<
    WorkspaceSnapshot & { id: string },
    string
  >;
  declare workspaces: Table<StoredWorkspace, WorkspaceDetails["id"]>;
  declare workflowStages: Table<
    StoredWorkflowStage,
    [WorkspaceDetails["id"], WorkflowStage["id"]]
  >;
  declare workItems: Table<
    StoredWorkItem,
    [WorkspaceDetails["id"], WorkItem["id"]]
  >;
  declare pendingOperations: Table<PendingOperation, Operation["id"]>;
  declare workspaceSyncMetadata: Table<
    WorkspaceSyncMetadata,
    WorkspaceDetails["id"]
  >;

  constructor(name = LOCAL_DATABASE_NAME) {
    super(name, { chromeTransactionDurability: "strict" });

    // Schema strings list keys/indexes only; all other domain fields are stored.
    // Scope stage IDs (e.g. "planned") and existing demo item IDs by workspace.
    this.version(1).stores({
      workspaces: "id",
      workflowStages: "[workspaceId+id], workspaceId",
      workItems: "[workspaceId+id], workspaceId, [workspaceId+stageId]",
      pendingOperations: "id, workspaceId, &[workspaceId+sequence]",
      workspaceSyncMetadata: "workspaceId",
    });
    this.version(2)
      .stores({})
      .upgrade(async (transaction) => {
        // Version 1 already stored the applied board and its queue. Migrate only
        // metadata; never replay operations, reseed entities, or clear the queue.
        const workspaces = await transaction.table("workspaces").toArray();
        for (const workspace of workspaces) {
          const metadata = await transaction
            .table("workspaceSyncMetadata")
            .get(workspace.id);
          const localRevision = await transaction
            .table("pendingOperations")
            .where({ workspaceId: workspace.id })
            .count();
          await transaction.table("workspaceSyncMetadata").put({
            workspaceId: workspace.id,
            lastServerVersion: null,
            lastSyncedAt: null,
            ...metadata,
            localRevision,
          });
        }
      });
    this.version(3)
      .stores({})
      .upgrade(async (transaction) => {
        // Before operation ingestion, server stages had no version column. SQL
        // migration 0002 gives every such stage the known baseline 0. Preserve
        // cached names and queued edits; the server still rejects base 0 if a
        // collaborator has renamed that stage since this migration.
        const workspaces = await transaction.table("workspaces").toArray();
        for (const workspace of workspaces) {
          if (workspace.source !== "server") continue;
          await transaction
            .table("workflowStages")
            .where({ workspaceId: workspace.id })
            .modify((stage) => {
              if (stage.version === undefined) stage.version = 0;
            });
          await transaction
            .table("pendingOperations")
            .where({ workspaceId: workspace.id })
            .modify((operation) => {
              if (
                operation.type === "RENAME_STAGE" &&
                operation.baseVersion === null
              )
                operation.baseVersion = 0;
            });
        }
      });
    this.version(4)
      .stores({ confirmedWorkspaces: "id" })
      .upgrade(async (transaction) => {
        const workspaces = await transaction.table("workspaces").toArray();
        for (const workspace of workspaces) {
          if (workspace.source === "server") {
            // Phase 5 used this timestamp for an upload acknowledgment, which did
            // not prove a completed pull. Preserve its separate acknowledgment log.
            await transaction
              .table("workspaceSyncMetadata")
              .update(workspace.id, { lastSyncedAt: null });
          }
        }
      });
    // Never invent a confirmed base from an old optimistic board or its upload
    // high-water mark. Legacy caches recover through an authorized snapshot.
    // Additive only: existing entities, queues, conflicts and metadata are untouched.
    this.version(5).stores({ recoveryBackups: "id, workspaceId" });
    this.on(
      "ready",
      () => {
        // Dexie can open compatible newer schemas. This app cannot safely infer
        // the meaning of a future format, so require a matching application.
        if (this.backendDB().version > 50) {
          throw new Dexie.VersionError(
            "This workspace needs a newer version of Relay.",
          );
        }
      },
      true,
    );
  }
}

let database: RelayDatabase | undefined;

// Importing this module during server rendering never accesses IndexedDB.
// Explicitly open on client mount so even an empty database appears in DevTools.
export async function openLocalDatabase(): Promise<RelayDatabase> {
  if (typeof window === "undefined") {
    throw new Error("Relay's local database is only available in the browser.");
  }

  database ??= new RelayDatabase();
  if (database.isOpen()) return database;
  const db = database;
  await new Promise<void>((resolve, reject) => {
    const blocked = () => {
      db.close();
      reject(
        new DOMException(
          "Close other Relay tabs and retry opening local storage.",
          "BlockedError",
        ),
      );
    };
    db.on("blocked", blocked);
    void db
      .open()
      .then(() => resolve(), reject)
      .finally(() => db.on("blocked").unsubscribe(blocked));
  });
  return database;
}
