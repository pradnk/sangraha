CREATE TABLE "organisation_branding" (
	"org_id" uuid PRIMARY KEY NOT NULL,
	"logo_mime" text NOT NULL,
	"logo_bytes" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organisation_branding" ADD CONSTRAINT "organisation_branding_org_id_organisations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organisations"("id") ON DELETE cascade ON UPDATE no action;