ALTER TABLE "operations" DROP CONSTRAINT "operations_payload_object";--> statement-breakpoint
ALTER TABLE "operations" ALTER COLUMN "payload" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ALTER COLUMN "base_version" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "operations" ADD CONSTRAINT "operations_payload_valid" CHECK ("operations"."payload" is null or jsonb_typeof("operations"."payload") in ('object', 'null'));