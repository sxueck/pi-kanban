import { createContext, useContext } from "react";

/**
 * Minimal dependency-free i18n: flat string dictionaries, {param}
 * interpolation, locale persisted in localStorage with navigator.language
 * fallback. UI copy only — identifiers, tool names, timestamps stay as-is.
 */

export type Locale = "zh" | "en";

const zh = {
	// nav / shell
	"nav.board": "看板",
	"nav.approvals": "审批",
	"nav.history": "历史",
	"nav.account": "账户",
	"nav.logout": "退出登录",
	"nav.switchLanguage": "切换语言",
	"gate.setupIntro": "创建首个管理员账户。需要服务端的 ADMIN_TOKEN。",
	"gate.loginIntro": "使用你的 pi-kanban 账户登录。",
	"gate.createAdmin": "创建管理员",
	"gate.signIn": "登录",
	"gate.failed": "连接失败",
	"auth.username": "用户名",
	"auth.password": "密码（至少 12 位）",
	"auth.bootstrapToken": "ADMIN_TOKEN",
	"account.title": "账户",
	"account.agentTokens": "机器 Agent Token",
	"account.agentTokenHint": "每台运行 pi 的机器使用一个 Token；只在创建时显示完整值。",
	"account.tokenName": "名称（例如：我的 Mac）",
	"account.createToken": "创建 Token",
	"account.revoke": "撤销",
	"account.created": "创建于 {time}",
	"account.lastUsed": "最近使用 {time}",
	"account.neverUsed": "尚未使用",
	"account.copyHint": "请立即复制，并在 shell 配置（如 ~/.zshrc）中导出为 PI_KANBAN_TOKEN。",
	"account.users": "用户管理",
	"account.newUser": "创建用户",
	"account.member": "成员",
	"account.admin": "管理员",
	"account.noTokens": "还没有机器 Token",
	"notfound.title": "页面不存在",
	"notfound.body": "该页面不存在——可能对应的会话已结束。",
	"notfound.back": "← 返回看板",

	// board
	"state.waiting_approval": "等待审批",
	"state.running": "运行中",
	"state.idle": "空闲",
	"state.offline": "离线",
	"board.hint.waiting_approval": "等待你的决定",
	"board.hint.running": "最早优先",
	"board.hint.idle": "最近活跃优先",
	"board.hint.offline": "心跳超时",
	"board.nothing_waiting": "没有等待你的事项",
	"board.empty": "暂无活跃的 pi 会话",
	"board.emptyHint": "在运行 pi 的机器上安装插件,然后启动一个会话。",
	"board.untitled": "(未命名会话)",
	"board.turns": "{n} 轮",
	"board.pendingApproval": "{n} 条待审批",
	"board.recent": "最近会话",
	"board.noRecent": "还没有会话记录",

	// history
	"history.title": "项目",
	"history.empty": "还没有项目",
	"history.emptyHint": "pi 会话上报后,项目会出现在这里。",
	"history.sessions": "{n} 个会话",
	"history.last": "最近 {time}",
	"sessions.title": "会话",
	"th.title": "标题",
	"th.state": "状态",
	"th.turns": "轮次",
	"th.cost": "费用",
	"th.started": "开始时间",

	// approvals
	"approvals.pending": "待审批 ({n})",
	"approvals.allClear": "全部处理完毕",
	"approvals.nothingWaiting": "没有等待你的事项",
	"approvals.localPrompt": "本地 TUI 也在弹窗确认",
	"approvals.approve": "批准",
	"approvals.deny": "拒绝",
	"approvals.recent": "最近决定",
	"th.when": "时间",
	"th.policy": "策略",
	"th.tool": "工具",
	"th.outcome": "结果",
	"th.by": "操作方",
	"approvals.localTui": "本地 TUI",

	// session detail — header
	"detail.started": "开始 {time}",
	"detail.active": "活跃于 {elapsed} 前",
	"detail.turns": "{n} 轮",
	"detail.toolCalls": "{n} 次工具调用",
	"detail.failed": "✗ {n} 次失败",
	"detail.todos": "待办",
	"detail.trace": "轨迹",
	"detail.approvals": "审批",
	"detail.banner": "{n} 条审批等待你的决定 →",

	// session detail — trace
	"trace.phases": "任务阶段",
	"trace.details": "执行轨迹明细",
	"trace.systemInit": "系统 · 初始化上下文",
	"trace.earlier": "更早的活动",
	"trace.turn": "第 {n} 轮",
	"trace.noData": "还没有记录到轮次",
	"trace.event": "事件",
	"trace.turnSpan": "第 {n} 轮 · {elapsed}",
	"trace.input": "输入",
	"trace.output": "输出",
	"trace.viewTurns": "轮次",
	"trace.viewCalls": "调用",
	"trace.search": "搜索",
	"trace.matches": "{shown}/{total} 条",
	"trace.noMatch": "没有匹配的记录",
	"trace.ofLongest": "占最长轮次的比例",
	"trace.running": "● 运行中",
	"trace.steps": "{n} 步",

	// trace row role tags
	"role.user": "用户",
	"role.assistant": "助手",
	"role.tool": "工具",
	"role.context": "上下文",
	"role.system": "系统",
} as const;

export type MsgKey = keyof typeof zh;

const en: Record<MsgKey, string> = {
	"nav.board": "Board",
	"nav.approvals": "Approvals",
	"nav.history": "History",
	"nav.account": "Account",
	"nav.logout": "Sign out",
	"nav.switchLanguage": "Switch language",
	"gate.setupIntro": "Create the first administrator account with the server ADMIN_TOKEN.",
	"gate.loginIntro": "Sign in with your pi-kanban account.",
	"gate.createAdmin": "Create administrator",
	"gate.signIn": "Sign in",
	"gate.failed": "connection failed",
	"auth.username": "Username",
	"auth.password": "Password (12+ characters)",
	"auth.bootstrapToken": "ADMIN_TOKEN",
	"account.title": "Account",
	"account.agentTokens": "Machine Agent Tokens",
	"account.agentTokenHint": "Use one token per machine running pi; the complete value is shown only once.",
	"account.tokenName": "Name (for example: My Mac)",
	"account.createToken": "Create token",
	"account.revoke": "Revoke",
	"account.created": "created {time}",
	"account.lastUsed": "last used {time}",
	"account.neverUsed": "never used",
	"account.copyHint": "Copy this value now and export it as PI_KANBAN_TOKEN in your shell profile (e.g. ~/.zshrc).",
	"account.users": "User management",
	"account.newUser": "Create user",
	"account.member": "Member",
	"account.admin": "Administrator",
	"account.noTokens": "No machine tokens yet",
	"notfound.title": "Page not found",
	"notfound.body": "This page doesn't exist — maybe the session ended.",
	"notfound.back": "← back to board",

	"state.waiting_approval": "waiting approval",
	"state.running": "running",
	"state.idle": "idle",
	"state.offline": "offline",
	"board.hint.waiting_approval": "blocked on your decision",
	"board.hint.running": "oldest first",
	"board.hint.idle": "recently active first",
	"board.hint.offline": "heartbeat stale",
	"board.nothing_waiting": "nothing waiting on you",
	"board.empty": "No live pi sessions",
	"board.emptyHint": "Install the plugin on a machine running pi, then start a session.",
	"board.untitled": "(untitled session)",
	"board.turns": "{n} turns",
	"board.pendingApproval": "{n} pending approval",
	"board.recent": "Recent sessions",
	"board.noRecent": "No sessions yet",

	"history.title": "Projects",
	"history.empty": "No projects yet",
	"history.emptyHint": "Projects appear here once a pi session reports in.",
	"history.sessions": "{n} sessions",
	"history.last": "last {time}",
	"sessions.title": "Sessions",
	"th.title": "Title",
	"th.state": "State",
	"th.turns": "Turns",
	"th.cost": "Cost",
	"th.started": "Started",

	"approvals.pending": "Pending ({n})",
	"approvals.allClear": "All clear",
	"approvals.nothingWaiting": "nothing waiting on you",
	"approvals.localPrompt": "local prompt also open",
	"approvals.approve": "Approve",
	"approvals.deny": "Deny",
	"approvals.recent": "Recent decisions",
	"th.when": "When",
	"th.policy": "Policy",
	"th.tool": "Tool",
	"th.outcome": "Outcome",
	"th.by": "By",
	"approvals.localTui": "local TUI",

	"detail.started": "started {time}",
	"detail.active": "active {elapsed} ago",
	"detail.turns": "{n} turns",
	"detail.toolCalls": "{n} tool calls",
	"detail.failed": "✗ {n} failed",
	"detail.todos": "Todos",
	"detail.trace": "Trace",
	"detail.approvals": "Approvals",
	"detail.banner": "{n} approval(s) waiting for your decision →",

	"trace.phases": "Phases",
	"trace.details": "Execution trace",
	"trace.systemInit": "System · init",
	"trace.earlier": "Earlier activity",
	"trace.turn": "Turn {n}",
	"trace.noData": "no turns recorded yet",
	"trace.event": "Event",
	"trace.turnSpan": "Turn {n} · {elapsed}",
	"trace.input": "Input",
	"trace.output": "Output",
	"trace.viewTurns": "Turns",
	"trace.viewCalls": "Calls",
	"trace.search": "Search",
	"trace.matches": "{shown}/{total}",
	"trace.noMatch": "no matching entries",
	"trace.ofLongest": "share of the longest turn",
	"trace.running": "● running",
	"trace.steps": "{n} steps",

	"role.user": "USER",
	"role.assistant": "ASSISTANT",
	"role.tool": "TOOL",
	"role.context": "CONTEXT",
	"role.system": "SYSTEM",
};

const DICTS: Record<Locale, Record<MsgKey, string>> = { zh, en };
const STORE_KEY = "pi-kanban-locale";

export function detectLocale(): Locale {
	try {
		const saved = localStorage.getItem(STORE_KEY);
		if (saved === "zh" || saved === "en") return saved;
	} catch {
		// storage unavailable (private mode) — fall through to navigator
	}
	return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function storeLocale(locale: Locale): void {
	try {
		localStorage.setItem(STORE_KEY, locale);
	} catch {
		// best effort only
	}
}

export type Translator = (key: MsgKey, params?: Record<string, string | number>) => string;

export function translate(locale: Locale): Translator {
	return (key, params) => {
		let s: string = DICTS[locale][key] ?? key;
		if (params) {
			for (const [k, v] of Object.entries(params)) s = s.replaceAll(`{${k}}`, String(v));
		}
		return s;
	};
}

export const I18nContext = createContext<{ locale: Locale; setLocale: (l: Locale) => void }>({
	locale: "en",
	setLocale: () => {},
});

export function useI18n(): { locale: Locale; setLocale: (l: Locale) => void; t: Translator } {
	const ctx = useContext(I18nContext);
	return { ...ctx, t: translate(ctx.locale) };
}
