ALTER TABLE "form_fields" ADD COLUMN "purpose_id" uuid;--> statement-breakpoint
ALTER TABLE "form_fields" ADD COLUMN "data_description" jsonb;--> statement-breakpoint
ALTER TABLE "form_fields" ADD CONSTRAINT "form_fields_purpose_id_purposes_id_fk" FOREIGN KEY ("purpose_id") REFERENCES "public"."purposes"("id") ON DELETE set null ON UPDATE no action;