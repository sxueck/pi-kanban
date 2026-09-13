ALTER TABLE "messages" ADD COLUMN "search_tokens" text[];--> statement-breakpoint
CREATE INDEX "idx_messages_search_tokens" ON "messages" USING gin ("search_tokens");--> statement-breakpoint
ALTER TABLE "turns" ADD COLUMN "search_tokens" text[];--> statement-breakpoint
CREATE INDEX "idx_turns_search_tokens" ON "turns" USING gin ("search_tokens");--> statement-breakpoint
ALTER TABLE "tool_calls" ADD COLUMN "search_tokens" text[];--> statement-breakpoint
CREATE INDEX "idx_tool_calls_search_tokens" ON "tool_calls" USING gin ("search_tokens");--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "search_tokens" text[];--> statement-breakpoint
CREATE INDEX "idx_project_memories_search_tokens" ON "project_memories" USING gin ("search_tokens");--> statement-breakpoint
-- scope="global" rows carry a null project_id: user-wide principles live in
-- the same versioned table so consolidation and digests share one pipeline.
ALTER TABLE "project_memories" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project_memories" ADD COLUMN "scope" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_project_memories_global" ON "project_memories" ("user_id", "scope", "superseded_at");--> statement-breakpoint
CREATE TABLE "global_analysis_states" (
	"user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"locked_at" timestamp with time zone,
	"last_inspection_at" timestamp with time zone,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "global_inspections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"redaction_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);--> statement-breakpoint
CREATE INDEX "idx_global_inspections_user" ON "global_inspections" ("user_id", "started_at");--> statement-breakpoint
CREATE TABLE "global_inspection_logs" (
	"inspection_id" uuid PRIMARY KEY NOT NULL REFERENCES "global_inspections"("id") ON DELETE CASCADE,
	"request_payload" jsonb NOT NULL,
	"response_content" text,
	"reasoning_content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "global_findings" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
	"kind" text NOT NULL,
	"severity" text NOT NULL,
	"summary" text NOT NULL,
	"detail" text,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution" text DEFAULT 'open' NOT NULL,
	"resolved_note" text,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_inspection_id" uuid REFERENCES "global_inspections"("id") ON DELETE SET NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "idx_global_findings_user" ON "global_findings" ("user_id", "resolution", "last_seen_at");--> statement-breakpoint
CREATE INDEX "idx_global_findings_recurrence" ON "global_findings" ("user_id", "kind");
