CREATE TYPE "public"."workspace_role" AS ENUM('owner', 'member');--> statement-breakpoint
CREATE TABLE "operations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"base_version" bigint NOT NULL,
	"author_id" uuid NOT NULL,
	"client_id" text,
	"server_version" bigint NOT NULL,
	"entity_version" bigint NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operations_workspace_server_version_unique" UNIQUE("workspace_id","server_version"),
	CONSTRAINT "operations_base_version_valid" CHECK ("operations"."base_version" between 0 and 9007199254740991),
	CONSTRAINT "operations_server_version_valid" CHECK ("operations"."server_version" between 1 and 9007199254740991),
	CONSTRAINT "operations_entity_version_valid" CHECK ("operations"."entity_version" between 0 and 9007199254740991),
	CONSTRAINT "operations_type_valid" CHECK (char_length(btrim("operations"."type")) > 0),
	CONSTRAINT "operations_entity_type_valid" CHECK ("operations"."entity_type" in ('workspace', 'stage', 'item')),
	CONSTRAINT "operations_payload_object" CHECK (jsonb_typeof("operations"."payload") = 'object')
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"auth_provider" text DEFAULT 'neon' NOT NULL,
	"auth_user_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_provider_identity_unique" UNIQUE("auth_provider","auth_user_id")
);
--> statement-breakpoint
CREATE TABLE "work_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"stage_id" uuid NOT NULL,
	"title" varchar(300) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_items_title_valid" CHECK (char_length(btrim("work_items"."title")) between 1 and 300),
	CONSTRAINT "work_items_position_valid" CHECK ("work_items"."position" >= 0),
	CONSTRAINT "work_items_version_valid" CHECK ("work_items"."version" between 0 and 9007199254740991)
);
--> statement-breakpoint
CREATE TABLE "workflow_stages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_stages_workspace_id_unique" UNIQUE("workspace_id","id"),
	CONSTRAINT "workflow_stages_name_valid" CHECK (char_length(btrim("workflow_stages"."name")) between 1 and 80),
	CONSTRAINT "workflow_stages_position_valid" CHECK ("workflow_stages"."position" >= 0)
);
--> statement-breakpoint
CREATE TABLE "workspace_members" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "workspace_role" NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_members_workspace_id_user_id_pk" PRIMARY KEY("workspace_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(120) NOT NULL,
	"version" bigint DEFAULT 0 NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_name_valid" CHECK (char_length(btrim("workspaces"."name")) between 1 and 120),
	CONSTRAINT "workspaces_version_valid" CHECK ("workspaces"."version" between 0 and 9007199254740991)
);
--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_items" ADD CONSTRAINT "work_items_workspace_stage_fk" FOREIGN KEY ("workspace_id","stage_id") REFERENCES "public"."workflow_stages"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_stages" ADD CONSTRAINT "workflow_stages_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_members" ADD CONSTRAINT "workspace_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "work_items_workspace_stage_position_idx" ON "work_items" USING btree ("workspace_id","stage_id","position","id");--> statement-breakpoint
CREATE INDEX "workflow_stages_workspace_position_idx" ON "workflow_stages" USING btree ("workspace_id","position","id");--> statement-breakpoint
CREATE INDEX "workspace_members_user_workspace_idx" ON "workspace_members" USING btree ("user_id","workspace_id");