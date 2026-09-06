ALTER TABLE "subject_types" ADD COLUMN "match_fields" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "duplicate_of_id" uuid;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "duplicate_marked_by" uuid;--> statement-breakpoint
ALTER TABLE "subjects" ADD COLUMN "duplicate_marked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_duplicate_of_id_subjects_id_fk" FOREIGN KEY ("duplicate_of_id") REFERENCES "public"."subjects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subjects" ADD CONSTRAINT "subjects_duplicate_marked_by_users_id_fk" FOREIGN KEY ("duplicate_marked_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "subjects_duplicate_of_idx" ON "subjects" USING btree ("duplicate_of_id");