CREATE TYPE "public"."access_action" AS ENUM('export_csv', 'view_subject', 'view_record', 'view_records', 'search_subjects', 'check_duplicates', 'sign_in');--> statement-breakpoint
CREATE TABLE "access_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"actor_id" uuid,
	"actor_username" text,
	"actor_role" text,
	"action" "access_action" NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"row_count" integer,
	"scope" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "access_events" ADD CONSTRAINT "access_events_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "access_events" ADD CONSTRAINT "access_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_events_target_idx" ON "access_events" USING btree ("org_id","target_type","target_id");--> statement-breakpoint
CREATE INDEX "access_events_actor_idx" ON "access_events" USING btree ("org_id","actor_id","at");--> statement-breakpoint
CREATE INDEX "access_events_at_idx" ON "access_events" USING btree ("at");