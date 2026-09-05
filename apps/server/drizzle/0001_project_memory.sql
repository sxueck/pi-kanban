CREATE TABLE model_settings (
	id integer PRIMARY KEY DEFAULT 1,
	base_url text NOT NULL DEFAULT '',
	model text NOT NULL DEFAULT 'gpt-4o-mini',
	api_key_cipher text,
	enabled boolean NOT NULL DEFAULT false,
	inspection_interval_minutes integer NOT NULL DEFAULT 60,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT model_settings_singleton CHECK (id = 1)
);

CREATE TABLE project_snapshots (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	project_id integer NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	session_id text NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
	snapshot_hash text NOT NULL,
	files jsonb NOT NULL,
	git jsonb NOT NULL,
	diagnostics jsonb NOT NULL,
	truncated boolean NOT NULL DEFAULT false,
	created_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT uq_project_snapshots_user_project_hash UNIQUE (user_id, project_id, snapshot_hash)
);
CREATE INDEX idx_project_snapshots_latest ON project_snapshots (user_id, project_id, created_at);

CREATE TABLE project_analysis_states (
	id serial PRIMARY KEY,
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	project_id integer NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	next_inspection_at timestamptz,
	locked_at timestamptz,
	last_inspection_at timestamptz,
	last_error text,
	latest_tree jsonb,
	updated_at timestamptz NOT NULL DEFAULT now(),
	CONSTRAINT uq_project_analysis_states_user_project UNIQUE (user_id, project_id)
);
CREATE INDEX idx_project_analysis_states_due ON project_analysis_states (next_inspection_at, locked_at);

CREATE TABLE project_inspections (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	project_id integer NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	trigger text NOT NULL,
	status text NOT NULL DEFAULT 'running',
	redaction_count integer NOT NULL DEFAULT 0,
	error text,
	started_at timestamptz NOT NULL DEFAULT now(),
	finished_at timestamptz
);
CREATE INDEX idx_project_inspections_project ON project_inspections (user_id, project_id, started_at);

CREATE TABLE project_memories (
	id serial PRIMARY KEY,
	memory_key uuid NOT NULL,
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	project_id integer NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
	version integer NOT NULL DEFAULT 1,
	kind text NOT NULL,
	content text NOT NULL,
	status text NOT NULL DEFAULT 'candidate',
	evidence jsonb NOT NULL,
	source_inspection_id uuid REFERENCES project_inspections (id) ON DELETE SET NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	superseded_at timestamptz,
	CONSTRAINT uq_project_memories_key_version UNIQUE (memory_key, version)
);
CREATE INDEX idx_project_memories_active ON project_memories (user_id, project_id, superseded_at);
