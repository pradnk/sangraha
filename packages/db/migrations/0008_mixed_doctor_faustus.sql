CREATE TYPE "public"."consent_action" AS ENUM('given', 'withdrawn', 'refused', 'asserted');--> statement-breakpoint
CREATE TYPE "public"."lawful_basis" AS ENUM('consent', 'guardian_consent', 'voluntary', 'state_benefit', 'medical_emergency', 'employment');--> statement-breakpoint
CREATE TYPE "public"."minor_basis" AS ENUM('dob', 'age_field', 'worker_declared', 'unknown');--> statement-breakpoint
CREATE TABLE "consent_notice_purposes" (
	"notice_version_id" uuid NOT NULL,
	"purpose_id" uuid NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "consent_notice_purposes_notice_version_id_purpose_id_pk" PRIMARY KEY("notice_version_id","purpose_id")
);
--> statement-breakpoint
CREATE TABLE "consent_notice_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"notice_id" uuid NOT NULL,
	"version_number" integer NOT NULL,
	"status" "form_version_status" DEFAULT 'draft' NOT NULL,
	"body" jsonb NOT NULL,
	"body_machine" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"body_sha256" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"published_by" uuid,
	"retracted_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consent_notices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" jsonb NOT NULL,
	"current_version_id" uuid,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purposes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"code" text NOT NULL,
	"name" jsonb NOT NULL,
	"description" jsonb,
	"lawful_basis" "lawful_basis" DEFAULT 'consent' NOT NULL,
	"retention_months" integer,
	"retention_statute" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consent_notice_purposes" ADD CONSTRAINT "consent_notice_purposes_notice_version_id_consent_notice_versions_id_fk" FOREIGN KEY ("notice_version_id") REFERENCES "public"."consent_notice_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_notice_purposes" ADD CONSTRAINT "consent_notice_purposes_purpose_id_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."purposes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_notice_versions" ADD CONSTRAINT "consent_notice_versions_notice_id_consent_notices_id_fk" FOREIGN KEY ("notice_id") REFERENCES "public"."consent_notices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_notice_versions" ADD CONSTRAINT "consent_notice_versions_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_notice_versions" ADD CONSTRAINT "consent_notice_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_notices" ADD CONSTRAINT "consent_notices_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purposes" ADD CONSTRAINT "purposes_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consent_notice_purposes_purpose_idx" ON "consent_notice_purposes" USING btree ("purpose_id");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_notice_versions_number_key" ON "consent_notice_versions" USING btree ("notice_id","version_number");--> statement-breakpoint
CREATE INDEX "consent_notice_versions_status_idx" ON "consent_notice_versions" USING btree ("notice_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "consent_notices_org_slug_key" ON "consent_notices" USING btree ("org_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "purposes_org_code_key" ON "purposes" USING btree ("org_id","code");