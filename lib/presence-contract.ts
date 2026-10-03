import { z } from "zod";

export const PRESENCE_HEARTBEAT_MS = 10_000;
export const PRESENCE_TTL_MS = 45_000;
export const EDITING_TTL_MS = 20_000;
export const presenceInputSchema = z.strictObject({
  clientId: z.uuid(),
  editingItemId: z.uuid().nullable(),
});
export const presenceResponseSchema = z.strictObject({
  workspaceId: z.uuid(),
  serverTime: z.iso.datetime(),
  members: z.array(z.strictObject({
    userId: z.uuid(),
    displayName: z.string().max(200),
    avatar: z.string().max(4),
    workspaceId: z.uuid(),
    status: z.enum(["online", "offline"]),
    lastSeen: z.iso.datetime(),
    editingItemId: z.uuid().nullable(),
  })).max(200),
});
export type PresenceMember = z.infer<typeof presenceResponseSchema>["members"][number];
export interface PresenceState {
  readonly members: readonly PresenceMember[];
  readonly error: string | null;
  readonly updatedAt: string | null;
  readonly editingItemId: string | null;
  readonly activeUntil: number;
}
export const initialPresenceState: PresenceState = {
  members: [], error: null, updatedAt: null, editingItemId: null, activeUntil: 0,
};
