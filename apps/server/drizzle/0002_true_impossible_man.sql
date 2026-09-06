ALTER TABLE "project_memories"
ADD COLUMN "module_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;
