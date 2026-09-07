CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"registration_id" uuid NOT NULL,
	"nps" integer NOT NULL,
	"liked" text,
	"improve" text,
	"topic_votes" text[],
	"liked_skipped" boolean DEFAULT false NOT NULL,
	"improve_skipped" boolean DEFAULT false NOT NULL,
	"topic_votes_skipped" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chk_feedback_nps_range" CHECK ("feedback"."nps" >= 0 AND "feedback"."nps" <= 10)
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "broadcast_opt_in_asked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_registration_id_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."registrations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_feedback_registration_id" ON "feedback" USING btree ("registration_id");