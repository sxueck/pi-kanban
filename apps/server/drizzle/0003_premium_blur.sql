CREATE TABLE "project_inspection_logs" (
	"inspection_id" uuid PRIMARY KEY NOT NULL,
	"request_payload" jsonb NOT NULL,
	"response_content" text,
	"reasoning_content" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_inspection_logs" ADD CONSTRAINT "project_inspection_logs_inspection_id_project_inspections_id_fk" FOREIGN KEY ("inspection_id") REFERENCES "public"."project_inspections"("id") ON DELETE cascade ON UPDATE no action;