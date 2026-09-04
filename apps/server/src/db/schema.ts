import {
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

export const machines = pgTable("machines", {
	id: text("id").primaryKey(), // stable client-generated machine id
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
		machineId: text("machine_id").notNull(),
		projectId: integer("project_id").references(() => projects.id),
		cwd: text("cwd").notNull(),
		branch: text("branch"),
		title: text("title"),
		state: text("state").notNull().default("idle"),
		modelId: text("model_id"),
		totalCostUsd: doublePrecision("total_cost_usd").notNull().default(0),
		turnCount: integer("turn_count").notNull().default(0),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
		lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
		endedAt: timestamp("ended_at", { withTimezone: true }),
		endReason: text("end_reason"),
	},
	(t) => [
		index("idx_sessions_state_activity").on(t.state, t.lastActivityAt),
		index("idx_sessions_project").on(t.projectId),
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
