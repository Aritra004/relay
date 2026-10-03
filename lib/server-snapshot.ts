import { z } from "zod";
import { stages as defaultStages } from "../components/workspace/workspace-data.ts";
import type { SavedWorkspace } from "./workspace-repository.ts";
import { validateSnapshot } from "./validate-workspace.ts";
import { WorkspaceApiError } from "./online-workspace.ts";

const id = z.uuid();
const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const role = z.enum(["owner", "member"]);
const snapshotSchema = z.object({
  workspace: z.object({ id, name: z.string().trim().min(1), version }),
  version,
  stages: z
    .array(
      z.object({
        id,
        name: z.string().trim().min(1),
        description: z.string(),
        position: version,
        version,
      }),
    )
    .min(1),
  items: z.array(
    z.object({
      id,
      title: z.string(),
      description: z.string(),
      stageId: id,
      position: version,
      version,
      updatedAt: z.iso.datetime({ offset: true }),
    }),
  ),
  members: z.array(z.object({ userId: id, name: z.string(), role })),
  membership: z.object({ userId: id, role }),
  stageOrder: z.array(id),
  itemOrderByStage: z.record(id, z.array(id)),
});

export function toLocalSnapshot(
  input: unknown,
  workspaceId: string,
  userId: string,
): SavedWorkspace {
  const parsed = snapshotSchema.safeParse(input);
  if (!parsed.success)
    throw new WorkspaceApiError(
      "invalid-response",
      "Invalid server snapshot. Local data was preserved.",
    );
  const data = parsed.data;
  if (
    data.workspace.id !== workspaceId ||
    data.membership.userId !== userId ||
    data.workspace.version !== data.version ||
    !data.members.some(
      (member) =>
        member.userId === userId && member.role === data.membership.role,
    ) ||
    new Set(data.stages.map((stage) => stage.id)).size !== data.stages.length ||
    new Set(data.items.map((item) => item.id)).size !== data.items.length
  ) {
    throw new WorkspaceApiError(
      "invalid-response",
      "The snapshot does not match the requested workspace or account.",
    );
  }
  const snapshot: SavedWorkspace = {
    workspace: {
      id: workspaceId,
      name: data.workspace.name,
      source: "server",
      cachedForUserId: userId,
      members: data.members.map((member) =>
        member.userId === userId ? "You" : member.name,
      ),
    },
    stages: Object.fromEntries(
      data.stages.map((stage, position) => [
        stage.id,
        {
          id: stage.id,
          name: stage.name,
          description: stage.description,
          version: stage.version,
          ...(defaultStages[position]
            ? { kind: defaultStages[position].id }
            : {}),
        },
      ]),
    ),
    items: Object.fromEntries(
      data.items.map((item) => [
        item.id,
        {
          id: item.id,
          title: item.title,
          description: item.description,
          stageId: item.stageId,
          version: item.version,
          updated: item.updatedAt,
          assignee: "Unassigned" as const,
          label: "Product" as const,
        },
      ]),
    ),
    stageOrder: data.stageOrder,
    itemOrderByStage: data.itemOrderByStage,
    pendingOperations: [],
    syncMetadata: {
      workspaceId,
      localRevision: 0,
      localGeneration: crypto.randomUUID(),
      lastServerVersion: data.version,
      confirmedServerVersion: data.version,
      currentServerVersion: data.version,
      lastSyncedAt: null,
      lastSnapshotAt: new Date().toISOString(),
      serverAccess: "authorized",
    },
  };
  try {
    validateSnapshot(snapshot);
  } catch {
    throw new WorkspaceApiError(
      "invalid-response",
      "The snapshot contains invalid relationships. Local data was preserved.",
    );
  }
  return snapshot;
}
