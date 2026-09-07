CREATE TYPE "public"."form_audience" AS ENUM('everyone', 'supervisors', 'admins');--> statement-breakpoint
CREATE TABLE "form_access" (
	"form_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "form_access_form_id_user_id_pk" PRIMARY KEY("form_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "forms" ADD COLUMN "audience" "form_audience" DEFAULT 'everyone' NOT NULL;--> statement-breakpoint
ALTER TABLE "form_access" ADD CONSTRAINT "form_access_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "form_access" ADD CONSTRAINT "form_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "form_access_user_idx" ON "form_access" USING btree ("user_id");