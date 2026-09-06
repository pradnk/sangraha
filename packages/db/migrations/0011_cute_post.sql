CREATE TABLE "consent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"client_event_uuid" uuid NOT NULL,
	"subject_id" uuid,
	"subject_pseudonym" text NOT NULL,
	"purpose_id" uuid NOT NULL,
	"notice_version_id" uuid,
	"action" "consent_action" NOT NULL,
	"lawful_basis" "lawful_basis" NOT NULL,
	"client_occurred_at" timestamp with time zone,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"seq" bigserial NOT NULL,
	"valid_until" timestamp with time zone,
	"notice_locale" text,
	"notice_text_sha256" text,
	"notice_mismatch" boolean DEFAULT false NOT NULL,
	"notice_seconds_shown" integer,
	"notice_read_aloud" boolean,
	"attested_by" uuid,
	"attested_role" text,
	"subject_is_minor" boolean,
	"minor_basis" "minor_basis",
	"guardian_name" text,
	"guardian_relationship" text,
	"guardian_contact" text,
	"guardian_evidence_seen" text,
	"guardian_verified" boolean,
	"pending_override" boolean DEFAULT false NOT NULL,
	"override_by" uuid,
	"override_role" text,
	"override_reason" text,
	"override_at" timestamp with time zone,
	"redacted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_subject_id_subjects_id_fk" FOREIGN KEY ("subject_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_purpose_id_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."purposes"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_notice_version_id_consent_notice_versions_id_fk" FOREIGN KEY ("notice_version_id") REFERENCES "public"."consent_notice_versions"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_attested_by_users_id_fk" FOREIGN KEY ("attested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_override_by_users_id_fk" FOREIGN KEY ("override_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_events_org_client_uuid_key" ON "consent_events" USING btree ("org_id","client_event_uuid");--> statement-breakpoint
CREATE INDEX "consent_events_current_idx" ON "consent_events" USING btree ("org_id","subject_id","purpose_id","occurred_at" DESC NULLS LAST,"seq" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "consent_events_pseudonym_idx" ON "consent_events" USING btree ("org_id","subject_pseudonym");--> statement-breakpoint
CREATE INDEX "consent_events_pending_override_idx" ON "consent_events" USING btree ("org_id","pending_override") WHERE pending_override;--> statement-breakpoint
/*
 * Consent must cite the exact words that were shown; a Section 7 legitimate use
 * has no notice to cite. Enforced here rather than in the code that writes the
 * row, so "we can always show what this person was told" is a property of the
 * database and not of whichever call site happened to remember.
 */
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_notice_required"
  CHECK (
    "notice_version_id" IS NOT NULL
    OR "lawful_basis" NOT IN ('consent', 'guardian_consent')
  );
