import { InvalidLocalDataError } from "./local-storage-errors.ts";
import type { WorkspaceSnapshot } from "./workspace-repository.ts";
import type { WorkspaceSyncMetadata } from "./local-db.ts";
import type { StageId } from "../components/workspace/workspace-data.ts";
import { conflictContextSchema } from "./conflict-contract.ts";
import { acknowledgmentSchema, operationSchema } from "./operation-contract.ts";
import { remoteOperationSchema } from "./sync-contract.ts";

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new InvalidLocalDataError(message);
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string";
const id = (value: unknown): value is string =>
  text(value) &&
  value.length > 0 &&
  !["__proto__", "prototype", "constructor"].includes(value);
const revision = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;
const stageId = (value: unknown): value is StageId => id(value);
const assignee = (value: unknown) =>
  typeof value === "string" &&
  ["You", "Mina", "Alex", "Unassigned"].includes(value);
const label = (value: unknown) =>
  typeof value === "string" &&
  ["Product", "Design", "Engineering"].includes(value);
const timestamp = (value: unknown) =>
  text(value) && Number.isFinite(Date.parse(value));

export function validateSyncMetadata(
  value: WorkspaceSyncMetadata,
  workspaceId: string,
) {
  check(
    record(value) &&
      value.workspaceId === workspaceId &&
      revision(value.localRevision) &&
      (value.localGeneration === undefined || id(value.localGeneration)) &&
      (value.lastServerVersion === null || revision(value.lastServerVersion)) &&
      (value.confirmedServerVersion === undefined ||
        value.confirmedServerVersion === null ||
        revision(value.confirmedServerVersion)) &&
      (value.currentServerVersion === undefined ||
        revision(value.currentServerVersion)) &&
      (value.receivedRemoteOperations === undefined ||
        revision(value.receivedRemoteOperations)) &&
      (value.lastSnapshotAt === undefined || timestamp(value.lastSnapshotAt)) &&
      (value.serverAccess === undefined ||
        ["authorized", "forbidden"].includes(value.serverAccess)) &&
      (value.lastSyncedAt === null || timestamp(value.lastSyncedAt)),
    "Invalid workspace sync metadata.",
  );
  const failure = value.uploadFailure;
  if (value.submittedOperation != null) {
    const op = value.submittedOperation;
    const payload = record(op) && op.type === "CREATE_ITEM" && record(op.payload)
      ? { title: op.payload.title, description: op.payload.description, stageId: op.payload.stageId }
      : op?.payload;
    check(record(op) && op.workspaceId === workspaceId && operationSchema.safeParse({ ...op, payload }).success, "Invalid frozen operation. Download recovery data; uploads are paused.");
  }
  if (value.acceptedSubmission != null) check(acknowledgmentSchema.safeParse(value.acceptedSubmission).success && value.acceptedSubmission.workspaceId === workspaceId, "Invalid stored operation receipt.");
  if (value.recentRemoteOperations !== undefined) check(Array.isArray(value.recentRemoteOperations) && value.recentRemoteOperations.length <= 20 && value.recentRemoteOperations.every((op) => remoteOperationSchema.safeParse(op).success && op.operation.workspaceId === workspaceId), "Invalid recent remote operations.");
  if (value.conflicts !== undefined) {
    check(
      Array.isArray(value.conflicts) &&
        value.conflicts.every(
          (c) =>
            record(c) &&
            conflictContextSchema.safeParse(c).success &&
            record(c.operation) &&
            c.operation.workspaceId === workspaceId &&
            c.operationId === c.operation.id &&
            id(c.id) &&
            timestamp(c.detectedAt) &&
            (c.status === "unresolved" ||
              (c.status === "resolved" &&
                timestamp(c.resolvedAt) &&
                (c.resolution === "mine" || c.resolution === "server"))),
        ),
      "Invalid saved conflict. Local work has been preserved for recovery.",
    );
  }
  if (
    value.confirmedServerVersion != null &&
    value.currentServerVersion !== undefined
  )
    check(
      value.confirmedServerVersion <= value.currentServerVersion,
      "Confirmed version exceeds the current server version.",
    );
  check(
    failure === undefined ||
      failure === null ||
      (record(failure) &&
        id(failure.operationId) &&
        ["validation", "authorization", "conflict", "temporary"].includes(
          failure.kind,
        ) &&
        text(failure.code) &&
        text(failure.message) &&
        Number.isInteger(failure.attempts) &&
        failure.attempts >= 1 &&
        failure.attempts <= 5 &&
        (failure.retryAt === null || timestamp(failure.retryAt))),
    "Invalid stored upload failure.",
  );
  const recent = value.recentAcknowledgments;
  check(
    recent === undefined ||
      (Array.isArray(recent) &&
        recent.length <= 20 &&
        recent.every(
          (ack) =>
            record(ack) &&
            id(ack.operationId) &&
            ack.workspaceId === workspaceId &&
            id(ack.entityId) &&
            ack.status === "accepted" &&
            revision(ack.serverVersion) &&
            ack.serverVersion > 0 &&
            revision(ack.entityVersion) &&
            ack.entityVersion > 0 &&
            timestamp(ack.acknowledgedAt) &&
            text(ack.type) &&
            [
              "CREATE_ITEM",
              "UPDATE_ITEM",
              "DELETE_ITEM",
              "MOVE_ITEM",
              "RENAME_STAGE",
            ].includes(ack.type),
        )),
    "Invalid stored acknowledgments.",
  );
}

export function validateSnapshot(snapshot: WorkspaceSnapshot) {
  check(record(snapshot), "Invalid workspace snapshot.");
  const {
    workspace,
    stages,
    items,
    stageOrder,
    itemOrderByStage,
    pendingOperations,
  } = snapshot;
  check(
    record(workspace) &&
      id(workspace.id) &&
      text(workspace.name) &&
      Array.isArray(workspace.members) &&
      workspace.members.every(text) &&
      (workspace.source === undefined ||
        (workspace.source === "server" && id(workspace.cachedForUserId))),
    "Invalid workspace details.",
  );
  check(
    record(stages) &&
      record(items) &&
      record(itemOrderByStage) &&
      Array.isArray(stageOrder) &&
      Array.isArray(pendingOperations),
    "Invalid workspace collections.",
  );
  const stageIds = new Set(stageOrder);
  const itemIds = new Set<string>();
  check(
    stageIds.size > 0 &&
      stageIds.size === stageOrder.length &&
      stageIds.size === Object.keys(stages).length &&
      stageIds.size === Object.keys(itemOrderByStage).length,
    "Invalid workspace stage ordering.",
  );
  for (const stage of stageOrder) {
    check(
      stageId(stage) &&
        record(stages[stage]) &&
        stages[stage].id === stage &&
        text(stages[stage].name) &&
        stages[stage].name.trim() &&
        text(stages[stage].description) &&
        (stages[stage].version === undefined ||
          revision(stages[stage].version)) &&
        Array.isArray(itemOrderByStage[stage]),
      "Invalid workflow stage.",
    );
    for (const itemId of itemOrderByStage[stage]) {
      const item = items[itemId];
      check(
        id(itemId) &&
          !itemIds.has(itemId) &&
          record(item) &&
          item.id === itemId &&
          item.stageId === stage &&
          text(item.title) &&
          item.title.length <= 300 &&
          text(item.description) &&
          item.description.length <= 20_000 &&
          revision(item.version) &&
          assignee(item.assignee) &&
          label(item.label) &&
          text(item.updated) &&
          (item.changed === undefined || typeof item.changed === "boolean"),
        "Invalid workspace item or ordering.",
      );
      itemIds.add(itemId);
    }
  }
  check(
    itemIds.size === Object.keys(items).length,
    "Workspace item ordering is incomplete.",
  );
  const operationIds = new Set<string>();
  for (const operation of pendingOperations) {
    check(
      record(operation) &&
        id(operation.id) &&
        !operationIds.has(operation.id) &&
        operation.workspaceId === workspace.id &&
        id(operation.entityId) &&
        timestamp(operation.timestamp),
      "Invalid pending operation identity.",
    );
    operationIds.add(operation.id);
    const payload = operation.payload;
    switch (operation.type) {
      case "CREATE_ITEM":
        check(
          operation.baseVersion === null &&
            record(payload) &&
            text(payload.title) &&
            payload.title.length <= 300 &&
            payload.title.trim() &&
            text(payload.description) &&
            payload.description.length <= 20_000 &&
            stageId(payload.stageId) &&
            assignee(payload.assignee) &&
            label(payload.label) &&
            revision(payload.version),
          "Invalid create operation.",
        );
        break;
      case "UPDATE_ITEM":
        check(
          revision(operation.baseVersion) &&
            record(payload) &&
            Object.keys(payload).length > 0 &&
            Object.keys(payload).every(
              (key) => key === "title" || key === "description",
            ) &&
            Object.values(payload).every(text) &&
            (payload.title === undefined || (text(payload.title) && payload.title.length <= 300)) &&
            (payload.description === undefined || (text(payload.description) && payload.description.length <= 20_000)),
          "Invalid update operation.",
        );
        break;
      case "DELETE_ITEM":
        check(
          revision(operation.baseVersion) && payload === null,
          "Invalid delete operation.",
        );
        break;
      case "MOVE_ITEM":
        check(
          revision(operation.baseVersion) &&
            record(payload) &&
            stageId(payload.stageId) &&
            (payload.beforeItemId === null || id(payload.beforeItemId)),
          "Invalid move operation.",
        );
        break;
      case "RENAME_STAGE":
        check(
          (operation.baseVersion === null || revision(operation.baseVersion)) &&
            stageId(operation.entityId) &&
            record(payload) &&
            text(payload.name) &&
            payload.name.length <= 80 &&
            payload.name.trim(),
          "Invalid rename operation.",
        );
        break;
      default:
        throw new InvalidLocalDataError("Unsupported pending operation type.");
    }
  }
}
