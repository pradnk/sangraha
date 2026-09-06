CREATE TYPE "public"."erasure_mode" AS ENUM('pseudonymise', 'hard_delete');--> statement-breakpoint
CREATE TYPE "public"."erasure_status" AS ENUM('requested', 'accepted', 'completed', 'refused');--> statement-breakpoint
CREATE TABLE "erasure_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"subject_id" uuid,
	"subject_pseudonym" text NOT NULL,
	"subject_name_at_request" text,
	"status" "erasure_status" DEFAULT 'requested' NOT NULL,
	"mode" "erasure_mode" DEFAULT 'pseudonymise' NOT NULL,
	"requested_by_name" text,
	"requested_by_relationship" text,
	"identity_checked_note" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"received_by" uuid,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"refusal_statute" text,
	"refusal_note" text,
	"completed_at" timestamp with time zone,
	"completed_summary" jsonb
);
--> statement-breakpoint
CREATE TABLE "legal_holds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"purpose_id" uuid NOT NULL,
	"statute" text NOT NULL,
	"section" text,
	"note" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "programme_counters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"form_id" uuid,
	"subject_type_id" uuid,
	"location_id" uuid,
	"period" timestamp with time zone NOT NULL,
	"record_count" integer DEFAULT 0 NOT NULL,
	"people_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_received_by_users_id_fk" FOREIGN KEY ("received_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "erasure_requests" ADD CONSTRAINT "erasure_requests_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_purpose_id_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."purposes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "legal_holds" ADD CONSTRAINT "legal_holds_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programme_counters" ADD CONSTRAINT "programme_counters_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "erasure_requests_org_status_idx" ON "erasure_requests" USING btree ("org_id","status");--> statement-breakpoint
CREATE INDEX "erasure_requests_subject_idx" ON "erasure_requests" USING btree ("subject_id");--> statement-breakpoint
CREATE INDEX "legal_holds_org_purpose_idx" ON "legal_holds" USING btree ("org_id","purpose_id");--> statement-breakpoint
CREATE UNIQUE INDEX "programme_counters_key" ON "programme_counters" USING btree ("org_id","form_id","subject_type_id","location_id","period");