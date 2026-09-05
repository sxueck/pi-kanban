import { useState } from "react";
import type { AgentTokenDTO, UserDTO } from "@pi-kanban/shared";
import { apiDelete, apiPost, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";

interface MeResponse {
	user: UserDTO;
}

interface CreatedAgentToken extends AgentTokenDTO {
	token: string;
}

export function Account() {
	const { t } = useI18n();
	const [refreshKey, setRefreshKey] = useState(0);
	const [name, setName] = useState("");
	const [createdToken, setCreatedToken] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { data: me } = useResource<MeResponse>("/api/auth/me");
	const { data: tokens } = useResource<AgentTokenDTO[]>("/api/agent-tokens", refreshKey);
	const isAdmin = me?.user.role === "admin";
	const { data: users } = useResource<UserDTO[]>(isAdmin ? "/api/users" : null, refreshKey);

	async function createToken(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		try {
			const created = await apiPost<CreatedAgentToken>("/api/agent-tokens", { name });
			setCreatedToken(created.token);
			setName("");
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	async function revoke(id: string) {
		setError(null);
		try {
			await apiDelete(`/api/agent-tokens/${id}`);
			setRefreshKey((key) => key + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<div className="account">
			<header>
				<h1 className="page-title">{t("account.title")}</h1>
				{me && <p className="muted">{me.user.username} · {isAdmin ? t("account.admin") : t("account.member")}</p>}
			</header>
			<section className="account-section">
				<h2>{t("account.agentTokens")}</h2>
				<p className="muted">{t("account.agentTokenHint")}</p>
				<form className="inline-form" onSubmit={(event) => void createToken(event)}>
					<input value={name} onChange={(event) => setName(event.target.value)} placeholder={t("account.tokenName")} maxLength={80} required />
					<button type="submit">{t("account.createToken")}</button>
				</form>
				{createdToken && (
					<div className="token-reveal">
						<p>{t("account.copyHint")}</p>
						<code>{createdToken}</code>
					</div>
				)}
				{(tokens?.length ?? 0) === 0 ? (
					<p className="muted">{t("account.noTokens")}</p>
				) : (
					<ul className="token-list">
						{tokens?.map((token) => (
							<li key={token.id}>
								<div>
									<strong>{token.name}</strong>
									<span>{t("account.created", { time: fmtTime(token.createdAt) })} · {token.lastUsedAt ? t("account.lastUsed", { time: fmtTime(token.lastUsedAt) }) : t("account.neverUsed")}</span>
								</div>
								<button type="button" className="deny" onClick={() => void revoke(token.id)}>{t("account.revoke")}</button>
							</li>
						))}
					</ul>
				)}
			</section>
			{isAdmin && <UserManagement users={users ?? []} onCreated={() => setRefreshKey((key) => key + 1)} />}
			{error && <p className="error">{error}</p>}
		</div>
	);
}

function UserManagement({ users, onCreated }: { users: UserDTO[]; onCreated: () => void }) {
	const { t } = useI18n();
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [role, setRole] = useState<"admin" | "member">("member");
	const [error, setError] = useState<string | null>(null);

	async function createUser(event: React.SyntheticEvent<HTMLFormElement>) {
		event.preventDefault();
		setError(null);
		try {
			await apiPost("/api/users", { username, password, role });
			setUsername("");
			setPassword("");
			onCreated();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		}
	}

	return (
		<section className="account-section">
			<h2>{t("account.users")}</h2>
			<form className="inline-form user-form" onSubmit={(event) => void createUser(event)}>
				<input value={username} onChange={(event) => setUsername(event.target.value)} placeholder={t("auth.username")} minLength={3} maxLength={40} required />
				<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder={t("auth.password")} minLength={12} required />
				<select value={role} onChange={(event) => setRole(event.target.value as "admin" | "member")}>
					<option value="member">{t("account.member")}</option>
					<option value="admin">{t("account.admin")}</option>
				</select>
				<button type="submit">{t("account.newUser")}</button>
			</form>
			{error && <p className="error">{error}</p>}
			<ul className="user-list">
				{users.map((user) => <li key={user.id}>{user.username}<span>{user.role === "admin" ? t("account.admin") : t("account.member")}</span></li>)}
			</ul>
		</section>
	);
}
