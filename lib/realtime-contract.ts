import { z } from "zod";
import {
  remoteOperationSchema,
  type RemoteOperation,
} from "./sync-contract.ts";

const version = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const realtimeEventSchema = z.discriminatedUnion("type", [
  z
    .strictObject({
      type: z.literal("operation.accepted"),
      workspaceId: z.uuid(),
      ...remoteOperationSchema.shape,
    })
    .refine((event) => event.workspaceId === event.operation.workspaceId),
  z.strictObject({
    type: z.enum(["stream.ready", "stream.checkpoint", "stream.catch-up"]),
    workspaceId: z.uuid(),
    serverVersion: version,
  }),
  z.strictObject({
    type: z.literal("stream.error"),
    workspaceId: z.uuid(),
    code: z.enum(["ACCESS_REVOKED", "STREAM_UNAVAILABLE"]),
  }),
]);
export type RealtimeEvent = z.infer<typeof realtimeEventSchema>;
export type RealtimeStatus =
  "disconnected" | "connecting" | "connected" | "reconnecting";
export interface RealtimeState {
  status: RealtimeStatus;
  latestReceivedServerVersion: number | null;
  latestRemoteOperation: RemoteOperation | null;
  lastEventAt: string | null;
  catchUpRequired: boolean;
  error: string | null;
}
export const initialRealtimeState: RealtimeState = {
  status: "disconnected",
  latestReceivedServerVersion: null,
  latestRemoteOperation: null,
  lastEventAt: null,
  catchUpRequired: false,
  error: null,
};

export function acceptedEvent(remote: RemoteOperation): RealtimeEvent {
  return {
    type: "operation.accepted",
    workspaceId: remote.operation.workspaceId,
    ...remote,
  };
}
