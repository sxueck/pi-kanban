ALTER TABLE "model_settings" ADD COLUMN "inspection_start_minute" integer DEFAULT 540 NOT NULL;--> statement-breakpoint
-- Old window start becomes the daily start time; interval/window end are gone.
UPDATE "model_settings" SET "inspection_start_minute" = "inspection_window_start";--> statement-breakpoint
ALTER TABLE "model_settings" ADD COLUMN "excluded_project_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "model_settings" DROP COLUMN "inspection_interval_minutes";--> statement-breakpoint
ALTER TABLE "model_settings" DROP COLUMN "inspection_window_start";--> statement-breakpoint
ALTER TABLE "model_settings" DROP COLUMN "inspection_window_end";
