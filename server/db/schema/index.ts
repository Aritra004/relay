import { sql } from "drizzle-orm";
import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  timestamp,
  integer,
  bigint,
  jsonb,
  primaryKey,
  unique,
  index,
  check,
  foreignKey,
} from "drizzle-orm/pg-core";

export const workspaceRole = pgEnum("workspace_role", ["owner", "member"]);
const timestamps = () => ({
  createdAt: timestamp("created_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull(),
});

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    // Provider identity is the mapping key; email is never used for authorization.
    authProvider: text("auth_provider").notNull().default("neon"),
    authUserId: text("auth_user_id").notNull(),
    email: text("email").notNull(),
    name: text("name").notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("users_provider_identity_unique").on(t.authProvider, t.authUserId),
  ],
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    // Accepted server mutations advance this inside the ingestion transaction.
    // Browser edits must never write it. Zero is the initial empty workspace.
    version: bigint("version", { mode: "number" }).default(0).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    check(
      "workspaces_name_valid",
      sql`char_length(btrim(${t.name})) between 1 and 120`,
    ),
    check(
      "workspaces_version_valid",
      sql`${t.version} between 0 and 9007199254740991`,
    ),
  ],
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: workspaceRole("role").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_members_user_workspace_idx").on(t.userId, t.workspaceId),
  ],
);

export const workflowStages = pgTable(
  "workflow_stages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 80 }).notNull(),
    description: text("description").default("").notNull(),
    position: integer("position").notNull(),
    version: bigint("version", { mode: "number" }).default(0).notNull(),
    ...timestamps(),
  },
  (t) => [
    unique("workflow_stages_workspace_id_unique").on(t.workspaceId, t.id),
    index("workflow_stages_workspace_position_idx").on(
      t.workspaceId,
      t.position,
      t.id,
    ),
    check(
      "workflow_stages_name_valid",
      sql`char_length(btrim(${t.name})) between 1 and 80`,
    ),
    check("workflow_stages_position_valid", sql`${t.position} >= 0`),
    check(
      "workflow_stages_version_valid",
      sql`${t.version} between 0 and 9007199254740991`,
    ),
  ],
);

export const workItems = pgTable(
  "work_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    stageId: uuid("stage_id").notNull(),
    title: varchar("title", { length: 300 }).notNull(),
    description: text("description").default("").notNull(),
    position: integer("position").notNull(),
    version: bigint("version", { mode: "number" }).default(0).notNull(),
    createdBy: uuid("created_by")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    ...timestamps(),
  },
  (t) => [
    // A stage in another workspace can never own this item.
    foreignKey({
      name: "work_items_workspace_stage_fk",
      columns: [t.workspaceId, t.stageId],
      foreignColumns: [workflowStages.workspaceId, workflowStages.id],
    }).onDelete("cascade"),
    index("work_items_workspace_stage_position_idx").on(
      t.workspaceId,
      t.stageId,
      t.position,
      t.id,
    ),
    check(
      "work_items_title_valid",
      sql`char_length(${t.title}) between 0 and 300`,
    ),
    check("work_items_position_valid", sql`${t.position} >= 0`),
    check(
      "work_items_version_valid",
      sql`${t.version} between 0 and 9007199254740991`,
    ),
  ],
);

export const operations = pgTable(
  "operations",
  {
    // Client operation identity is also the global idempotency key.
    id: uuid("id").primaryKey(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    // No entity FK: accepted delete operations must outlive their target.
    entityId: uuid("entity_id").notNull(),
    type: text("type").notNull(),
    // Delete operations have no payload; creates have no base entity version.
    payload: jsonb("payload").$type<Record<string, unknown> | null>(),
    baseVersion: bigint("base_version", { mode: "number" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    clientId: text("client_id"),
    // Per-workspace accepted order, assigned atomically during ingestion.
    serverVersion: bigint("server_version", { mode: "number" }).notNull(),
    entityVersion: bigint("entity_version", { mode: "number" }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    unique("operations_workspace_server_version_unique").on(
      t.workspaceId,
      t.serverVersion,
    ),
    check(
      "operations_base_version_valid",
      sql`${t.baseVersion} between 0 and 9007199254740991`,
    ),
    check(
      "operations_server_version_valid",
      sql`${t.serverVersion} between 1 and 9007199254740991`,
    ),
    check(
      "operations_entity_version_valid",
      sql`${t.entityVersion} between 0 and 9007199254740991`,
    ),
    check("operations_type_valid", sql`char_length(btrim(${t.type})) > 0`),
    check(
      "operations_entity_type_valid",
      sql`${t.entityType} in ('workspace', 'stage', 'item')`,
    ),
    check(
      "operations_payload_valid",
      sql`${t.payload} is null or jsonb_typeof(${t.payload}) in ('object', 'null')`,
    ),
  ],
);

// TTL leases only. Migration makes this UNLOGGED: restart/crash may discard it.
// It never participates in snapshots, workspace versions, or operation history.
export const presenceLeases = pgTable("presence_leases", {
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  clientId: uuid("client_id").notNull(),
  editingItemId: uuid("editing_item_id"),
  lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  primaryKey({ columns: [t.workspaceId, t.userId, t.clientId] }),
  index("presence_leases_expiry_idx").on(t.lastSeen),
]);

// Compact, permanent idempotency evidence after the replay payload is pruned.
// Also preserves CREATE_ITEM tombstones so a deleted ID cannot be resurrected.
export const operationReceipts = pgTable("operation_receipts", {
  id: uuid("id").primaryKey(),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  authorId: uuid("author_id").notNull().references(() => users.id, { onDelete: "restrict" }),
  entityId: uuid("entity_id").notNull(),
  type: text("type").notNull(),
  fingerprint: varchar("fingerprint", { length: 64 }).notNull(),
  serverVersion: bigint("server_version", { mode: "number" }).notNull(),
  entityVersion: bigint("entity_version", { mode: "number" }).notNull(),
}, (t) => [index("operation_receipts_entity_idx").on(t.workspaceId, t.entityId, t.type)]);
