ALTER TABLE "organisations" ADD COLUMN "legal_name" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "entity_type" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "registration_number" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "registered_address" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "grievance_officer_name" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "grievance_officer_email" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "grievance_officer_phone" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "dpo_name" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "dpo_email" text;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "data_region" text DEFAULT 'IN' NOT NULL;--> statement-breakpoint
ALTER TABLE "organisations" ADD COLUMN "is_significant_data_fiduciary" boolean DEFAULT false NOT NULL;