CREATE TABLE "operation_receipts" (
	"id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"entity_id" uuid NOT NULL,
	"type" text NOT NULL,
	"fingerprint" varchar(64) NOT NULL,
	"server_version" bigint NOT NULL,
	"entity_version" bigint NOT NULL
);
--> statement-breakpoint
CREATE UNLOGGED TABLE "presence_leases" (
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"editing_item_id" uuid,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "presence_leases_workspace_id_user_id_client_id_pk" PRIMARY KEY("workspace_id","user_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "operation_receipts" ADD CONSTRAINT "operation_receipts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operation_receipts" ADD CONSTRAINT "operation_receipts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_leases" ADD CONSTRAINT "presence_leases_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "presence_leases" ADD CONSTRAINT "presence_leases_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "operation_receipts_entity_idx" ON "operation_receipts" USING btree ("workspace_id","entity_id","type");--> statement-breakpoint
CREATE INDEX "presence_leases_expiry_idx" ON "presence_leases" USING btree ("last_seen");
