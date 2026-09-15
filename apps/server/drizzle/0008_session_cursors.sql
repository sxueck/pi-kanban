-- Per-session incremental inspection cursors (see project_analysis_states.sessionCursors).
ALTER TABLE "project_analysis_states" ADD COLUMN "session_cursors" jsonb;
