import { z } from "zod";

// The HTTP contract, shared by the uploader and ingestion service. No author,
// local revision, optimistic entity version, or UI fields cross this boundary.
const version = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER - 1);
const metadata = {
  id: z.uuid(),
  workspaceId: z.uuid(),
  entityId: z.uuid(),
  timestamp: z.iso.datetime(),
};
const title = z
  .string()
  .min(1)
  .max(300)
  .refine((s) => s.trim().length > 0);
const description = z.string().max(20_000);
export const operationSchema = z.discriminatedUnion("type", [
  z.strictObject({
    ...metadata,
    type: z.literal("CREATE_ITEM"),
    baseVersion: z.null(),
    payload: z.strictObject({ title, description, stageId: z.uuid() }),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("UPDATE_ITEM"),
    baseVersion: version,
    payload: z
      .strictObject({
        // The local editor persists every keystroke, including a cleared title.
        title: z.string().max(300).optional(),
        description: description.optional(),
      })
      .refine(
        (p) => Object.keys(p).length > 0,
        "Specify at least one editable field.",
      ),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("DELETE_ITEM"),
    baseVersion: version,
    payload: z.null(),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("MOVE_ITEM"),
    baseVersion: version,
    payload: z.strictObject({
      stageId: z.uuid(),
      beforeItemId: z.uuid().nullable(),
    }),
  }),
  z.strictObject({
    ...metadata,
    type: z.literal("RENAME_STAGE"),
    baseVersion: version,
    payload: z.strictObject({
      name: z
        .string()
        .min(1)
        .max(80)
        .refine((s) => s.trim().length > 0),
    }),
  }),
]);
export type SubmittedOperation = z.infer<typeof operationSchema>;

export const acknowledgmentSchema = z.strictObject({
  operationId: z.uuid(),
  workspaceId: z.uuid(),
  entityId: z.uuid(),
  status: z.literal("accepted"),
  serverVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  // Deletes report their final (tombstone) version in the durable operation log.
  entityVersion: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
});
export type OperationAcknowledgment = z.infer<typeof acknowledgmentSchema>;
export type OperationFailureKind =
  "validation" | "authorization" | "conflict" | "temporary";
export interface OperationFailure {
  operationId: string;
  kind: OperationFailureKind;
  code: string;
  message: string;
  attempts: number;
  retryAt: string | null;
}
export interface RecentAcknowledgment extends OperationAcknowledgment {
  type: SubmittedOperation["type"];
  acknowledgedAt: string;
}
