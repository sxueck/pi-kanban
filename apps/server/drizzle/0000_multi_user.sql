-- This migration intentionally removes the pre-multi-user session history: it has no trustworthy owner.
DELETE FROM sessions;

CREATE TABLE users (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	username text NOT NULL UNIQUE,
	password_hash text NOT NULL,
	role text NOT NULL DEFAULT 'member',
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_users_username ON users (username);

CREATE TABLE web_sessions (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	token_hash text NOT NULL UNIQUE,
	expires_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_web_sessions_expiry ON web_sessions (expires_at);

CREATE TABLE agent_tokens (
	id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
	user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
	name text NOT NULL,
	token_hash text NOT NULL UNIQUE,
	created_at timestamptz NOT NULL DEFAULT now(),
	last_used_at timestamptz,
	revoked_at timestamptz
);
CREATE INDEX idx_agent_tokens_user ON agent_tokens (user_id);

ALTER TABLE machines ADD COLUMN user_id uuid REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE sessions ADD COLUMN user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE;
CREATE INDEX idx_sessions_user_activity ON sessions (user_id, last_activity_at);
