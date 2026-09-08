CREATE TABLE "project_findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"project_id" integer NOT NULL,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text,
	"session_id" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_inspection_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "occurrence_count" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "last_seen_inspection_id" uuid;--> statement-breakpoint
ALTER TABLE "project_findings" ADD CONSTRAINT "project_findings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_findings" ADD CONSTRAINT "project_findings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_findings" ADD CONSTRAINT "project_findings_source_inspection_id_project_inspections_id_fk" FOREIGN KEY ("source_inspection_id") REFERENCES "public"."project_inspections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_project_findings_project" ON "project_findings" USING btree ("user_id","project_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_project_findings_recurrence" ON "project_findings" USING btree ("user_id","project_id","kind");--> statement-breakpoint
ALTER TABLE "project_memories" ADD CONSTRAINT "project_memories_last_seen_inspection_id_project_inspections_id_fk" FOREIGN KEY ("last_seen_inspection_id") REFERENCES "public"."project_inspections"("id") ON DELETE set null ON UPDATE no action;