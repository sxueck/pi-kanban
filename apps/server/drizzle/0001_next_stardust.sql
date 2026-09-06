ALTER TABLE "model_settings" ADD COLUMN "inspection_window_start" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_settings" ADD COLUMN "inspection_window_end" integer DEFAULT 1439 NOT NULL;--> statement-breakpoint
ALTER TABLE "model_settings" ADD COLUMN "inspection_weekdays" integer DEFAULT 127 NOT NULL;
