import {
	bigint,
	boolean,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	serial,
	text,
	timestamp,
	unique,
	uuid,
} from "drizzle-orm/pg-core";

/**
 * Schema scoped to this product's needs: live progress, remote approvals,
 * history by git project.
 */

export const users = pgTable(
	"users",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		username: text("username").notNull().unique(),
		passwordHash: text("password_hash").notNull(),
		role: text("role").notNull().default("member"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("idx_users_username").on(t.username)],
);

export const webSessions = pgTable(
	"web_sessions",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull().unique(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("idx_web_sessions_expiry").on(t.expiresAt)],
);

export const agentTokens = pgTable(
	"agent_tokens",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		tokenHash: text("token_hash").notNull().unique(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(t) => [index("idx_agent_tokens_user").on(t.userId)],
);

export const machines = pgTable("machines", {
	id: text("id").primaryKey(), // stable client-generated machine id
	userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
	name: text("name"),
	lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projects = pgTable(
	"projects",
	{
		id: serial("id").primaryKey(),
		name: text("name").notNull(),
		gitRemote: text("git_remote").unique(),
		primaryPath: text("primary_path"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [index("idx_projects_name").on(t.name)],
);

export const sessions = pgTable(
	"sessions",
	{
		id: text("id").primaryKey(), // pi session id
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		machineId: text("machine_id").notNull(),
		projectId: integer("project_id").references(() => projects.id),
		cwd: text("cwd").notNull(),
		branch: text("branch"),
		title: text("title"),
		state: text("state").notNull().default("idle"),
		modelId: text("model_id"),
		totalCostUsd: doublePrecision("total_cost_usd").notNull().default(0),
		turnCount: integer("turn_count").notNull().default(0),
		// Token aggregates, fed from pi assistant-message usage blocks.
		inputTokens: bigint("input_tokens", { mode: "number" }).notNull().default(0),
		cacheReadTokens: bigint("cache_read_tokens", { mode: "number" }).notNull().default(0),
		totalTokens: bigint("total_tokens", { mode: "number" }).notNull().default(0),
		// Latest observed context size vs the model's window (0 = unreported).
		contextTokens: integer("context_tokens").notNull().default(0),
		contextWindow: integer("context_window").notNull().default(0),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
		lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		endReason: text("end_reason"),
	},
	(t) => [
		index("idx_sessions_state_activity").on(t.state, t.lastActivityAt),
		index("idx_sessions_project").on(t.projectId),
		index("idx_sessions_user_activity").on(t.userId, t.lastActivityAt),
	],
);

export const turns = pgTable(
	"turns",
	{
		id: serial("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		position: integer("position").notNull(),
		prompt: text("prompt").notNull(),
		state: text("state").notNull().default("running"), // running | done
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		ttftMs: integer("ttft_ms"),
	},
	(t) => [unique("uq_turns_session_position").on(t.sessionId, t.position)],
);

export const messages = pgTable(
	"messages",
	{
		id: serial("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		position: integer("position").notNull(),
		turnPosition: integer("turn_position"),
		role: text("role").notNull(), // user | assistant | toolResult | custom
		excerpt: text("excerpt"),
		customType: text("custom_type"),
		usage: jsonb("usage"),
		costUsd: doublePrecision("cost_usd"),
		modelId: text("model_id"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("uq_messages_session_position").on(t.sessionId, t.position),
		index("idx_messages_session").on(t.sessionId),
	],
);

export const toolCalls = pgTable(
	"tool_calls",
	{
		id: serial("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		toolCallId: text("tool_call_id").notNull(),
		turnPosition: integer("turn_position"),
		toolName: text("tool_name").notNull(),
		input: jsonb("input"),
		resultExcerpt: text("result_excerpt"),
		isError: boolean("is_error"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		durationMs: integer("duration_ms"),
	},
	(t) => [
		unique("uq_tool_calls_session_call").on(t.sessionId, t.toolCallId),
		index("idx_tool_calls_session").on(t.sessionId),
	],
);

/** Append-only versioned todo snapshots (each list supersedes the previous). */
export const todoLists = pgTable(
	"todo_lists",
	{
		id: serial("id").primaryKey(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		supersededAt: timestamp("superseded_at", { withTimezone: true }),
	},
	(t) => [index("idx_todo_lists_session_active").on(t.sessionId, t.supersededAt)],
);

export const todos = pgTable(
	"todos",
	{
		id: serial("id").primaryKey(),
		listId: integer("list_id")
			.notNull()
			.references(() => todoLists.id, { onDelete: "cascade" }),
		position: integer("position").notNull(),
		content: text("content").notNull(),
		state: text("state").notNull(), // pending | in_progress | current | completed | done ...
	},
	(t) => [unique("uq_todos_list_position").on(t.listId, t.position)],
);

export const approvals = pgTable(
	"approvals",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		machineId: text("machine_id").notNull(),
		toolCallId: text("tool_call_id"),
		toolName: text("tool_name").notNull(),
		input: jsonb("input"),
		policyLabel: text("policy_label").notNull(),
		status: text("status").notNull().default("pending"), // pending | approved | denied | expired | local_resolved
		localPrompted: boolean("local_prompted").notNull().default(false),
		localDecision: text("local_decision"), // approved | denied (audit when local won)
		requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		decidedBy: text("decided_by"),
		note: text("note"),
	},
	(t) => [
		index("idx_approvals_status").on(t.status, t.requestedAt),
		index("idx_approvals_session").on(t.sessionId),
	],
);

export const modelSettings = pgTable("model_settings", {
	id: integer("id").primaryKey().default(1),
	baseUrl: text("base_url").notNull().default(""),
	model: text("model").notNull().default("gpt-4o-mini"),
	apiKeyCipher: text("api_key_cipher"),
	enabled: boolean("enabled").notNull().default(false),
	inspectionIntervalMinutes: integer("inspection_interval_minutes").notNull().default(60),
	inspectionWindowStart: integer("inspection_window_start").notNull().default(0),
	inspectionWindowEnd: integer("inspection_window_end").notNull().default(1439),
	// weekday bit mask: bit d = weekday d (0 = Sunday); 127 = every day
	inspectionWeekdays: integer("inspection_weekdays").notNull().default(127),
	updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const projectSnapshots = pgTable(
	"project_snapshots",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		sessionId: text("session_id")
			.notNull()
			.references(() => sessions.id, { onDelete: "cascade" }),
		snapshotHash: text("snapshot_hash").notNull(),
		files: jsonb("files").notNull(),
		git: jsonb("git").notNull(),
		diagnostics: jsonb("diagnostics").notNull(),
		truncated: boolean("truncated").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("uq_project_snapshots_user_project_hash").on(t.userId, t.projectId, t.snapshotHash),
		index("idx_project_snapshots_latest").on(t.userId, t.projectId, t.createdAt),
	],
);

export const projectAnalysisStates = pgTable(
	"project_analysis_states",
	{
		id: serial("id").primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		nextInspectionAt: timestamp("next_inspection_at", { withTimezone: true }),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lastInspectionAt: timestamp("last_inspection_at", { withTimezone: true }),
		lastError: text("last_error"),
		latestTree: jsonb("latest_tree"),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("uq_project_analysis_states_user_project").on(t.userId, t.projectId),
		index("idx_project_analysis_states_due").on(t.nextInspectionAt, t.lockedAt),
	],
);

export const projectInspections = pgTable(
	"project_inspections",
	{
		id: uuid("id").primaryKey().defaultRandom(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		trigger: text("trigger").notNull(),
		status: text("status").notNull().default("running"),
		redactionCount: integer("redaction_count").notNull().default(0),
		error: text("error"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(t) => [index("idx_project_inspections_project").on(t.userId, t.projectId, t.startedAt)],
);

/**
 * Full inspection transcript: the exact redacted input sent to the model and
 * its raw output, for the dashboard log panel. 1:1 with a project_inspections
 * run; rows are pruned to the newest RETAINED_INSPECTION_LOGS per project.
 */
export const projectInspectionLogs = pgTable(
	"project_inspection_logs",
	{
		inspectionId: uuid("inspection_id")
			.primaryKey()
			.references(() => projectInspections.id, { onDelete: "cascade" }),
		requestPayload: jsonb("request_payload").notNull(),
		responseContent: text("response_content"),
		reasoningContent: text("reasoning_content"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
);

export const projectMemories = pgTable(
	"project_memories",
	{
		id: serial("id").primaryKey(),
		memoryKey: uuid("memory_key").notNull(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		projectId: integer("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		version: integer("version").notNull().default(1),
		kind: text("kind").notNull(),
		content: text("content").notNull(),
		status: text("status").notNull().default("candidate"),
		evidence: jsonb("evidence").notNull(),
		moduleIds: jsonb("module_ids").notNull().default([]),
		sourceInspectionId: uuid("source_inspection_id").references(() => projectInspections.id, { onDelete: "set null" }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		supersededAt: timestamp("superseded_at", { withTimezone: true }),
	},
	(t) => [
		unique("uq_project_memories_key_version").on(t.memoryKey, t.version),
		index("idx_project_memories_active").on(t.userId, t.projectId, t.supersededAt),
	],
);
