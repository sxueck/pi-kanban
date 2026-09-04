import { useEffect, useState } from "react";
import { Link, Route, Routes, useLocation } from "react-router-dom";
import { getToken, setToken } from "./api.js";
import { Board } from "./views/Board.js";
import { Approvals } from "./views/Approvals.js";
import { History } from "./views/History.js";
import { ProjectSessions } from "./views/History.js";
import { SessionDetail } from "./views/SessionDetail.js";

export function App() {
	const [authed, setAuthed] = useState(() => Boolean(getToken()));
	if (!authed) {
		return <TokenGate onOk={() => setAuthed(true)} />;
	}
	return (
		<div className="app">
			<Nav />
			<main className="content">
				<Routes>
					<Route path="/" element={<Board />} />
					<Route path="/approvals" element={<Approvals />} />
					<Route path="/history" element={<History />} />
					<Route path="/history/project/:id" element={<ProjectSessions />} />
					<Route path="/sessions/:id" element={<SessionDetail />} />
					<Route path="*" element={<NotFound />} />
				</Routes>
			</main>
		</div>
	);
}

function TokenGate({ onOk }: { onOk: () => void }) {
	const [value, setValue] = useState("");
	const [error, setError] = useState<string | null>(null);
	return (
		<div className="token-gate">
			<h1>pi-kanban</h1>
			<p>Enter the dashboard token (ADMIN_TOKEN on the server).</p>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					fetch("/api/board", { headers: { authorization: `Bearer ${value}` } })
						.then((res) => {
							if (res.status !== 200) throw new Error(`server said ${res.status}`);
							setToken(value);
							onOk();
						})
						.catch((err: unknown) =>
							setError(err instanceof Error ? err.message : "connection failed"),
						);
				}}
			>
				<input
					type="password"
					placeholder="token"
					value={value}
					onChange={(e) => setValue(e.target.value)}
					autoFocus
				/>
				<button type="submit">Enter</button>
			</form>
			{error && <p className="error">{error}</p>}
		</div>
	);
}

function Nav() {
	const { pathname } = useLocation();
	const pendingBadge = usePendingCount();
	const links: Array<[string, string]> = [
		["/", "Board"],
		["/approvals", pendingBadge > 0 ? `Approvals (${pendingBadge})` : "Approvals"],
		["/history", "History"],
	];
	return (
		<nav className="nav">
			<span className="nav-brand">pi-kanban</span>
			{links.map(([to, label]) => (
				<Link key={to} to={to} className={pathname === to ? "active" : ""}>
					{label}
				</Link>
			))}
		</nav>
	);
}

function usePendingCount(): number {
	const [count, setCount] = useState(0);
	// Cheap: piggyback on the SSE stream; poll every 10s.
	useEffect(() => {
		let cancelled = false;
		const load = () => {
			fetch("/api/approvals?status=pending", {
				headers: { authorization: `Bearer ${getToken()}` },
			})
				.then((res) => (res.ok ? res.json() : []))
				.then((rows: unknown[]) => {
					if (!cancelled) setCount(rows.length);
				})
				.catch(() => {});
		};
		load();
		const timer = setInterval(load, 10_000);
		return () => {
			cancelled = true;
			clearInterval(timer);
		};
	}, []);
	return count;
}

function NotFound() {
	return (
		<div className="empty">
			<h2>Not found</h2>
			<button onClick={() => { setToken(""); location.reload(); }}>Reset token</button>
		</div>
	);
}
