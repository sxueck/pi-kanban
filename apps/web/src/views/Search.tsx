import { useState } from "react";
import { Link } from "react-router-dom";
import type { SearchScope, SearchResultDTO } from "@pi-kanban/shared";
import { apiErrorMessage, fmtTime, useResource } from "../api.js";
import { useI18n } from "../i18n.js";
import { Skeleton } from "../components/skeleton.js";

const SCOPES: SearchScope[] = ["all", "sessions", "memories"];

/**
 * Cross-project cloud search: ranked session summaries and decision-point
 * memories across every project of the account. Full transcript replay stays
 * a local-session concern (the hint line points at session_search).
 */
export function Search() {
	const { t } = useI18n();
	const [query, setQuery] = useState("");
	const [submitted, setSubmitted] = useState("");
	const [scope, setScope] = useState<SearchScope>("all");
	const path = submitted ? `/api/search?q=${encodeURIComponent(submitted)}&scope=${scope}` : null;
	const { data: results, error, loading } = useResource<SearchResultDTO>(path);
	const hasResults = Boolean(results && (results.sessions.length > 0 || results.memories.length > 0));
	const resultCount = (results?.sessions.length ?? 0) + (results?.memories.length ?? 0);

	function submitSearch(value = query) {
		setQuery(value);
		setSubmitted(value.trim());
	}

	function clearSearch() {
		setQuery("");
		setSubmitted("");
	}

	return (
		<div className="history search-view">
			<header className="search-header">
				<h1 className="page-title">{t("search.title")}</h1>
				<p className="muted search-intro">{t("search.intro")}</p>
				<form
					className="search-form"
					onSubmit={(event) => {
						event.preventDefault();
						submitSearch();
					}}
				>
					<label className="sr-only" htmlFor="cross-project-search">{t("search.label")}</label>
					<input
						id="cross-project-search"
						autoFocus
						value={query}
						placeholder={t("search.placeholder")}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<button type="submit" disabled={!query.trim() || loading}>
						{t("search.submit")}
					</button>
					{submitted && (
						<button className="secondary search-clear" type="button" onClick={clearSearch}>
							{t("search.clear")}
						</button>
					)}
					<div className="board-chips search-scopes" role="group" aria-label={t("search.scopeLabel")}>
						{SCOPES.map((value) => (
							<button
								key={value}
								type="button"
								className={scope === value ? "on" : ""}
								aria-pressed={scope === value}
								disabled={loading}
								onClick={() => setScope(value)}
							>
								{t(`search.scope.${value}`)}
							</button>
						))}
					</div>
				</form>
				<p className="muted search-hint">{t("search.hint")}</p>
			</header>

			{error && <div className="error search-feedback" role="alert">{apiErrorMessage(error)}</div>}
			{!submitted && <SearchIdle onExample={submitSearch} />}
			{loading && submitted && <Skeleton className="search-skeleton" rows={3} rowClassName="search-skeleton-row" labelKey="search.loading" />}
			{results && !hasResults && (
				<div className="empty search-empty">
					<h2>{t("search.empty")}</h2>
					<p>{t("search.emptyHint", { query: submitted, scope: t(`search.scope.${scope}`) })}</p>
				</div>
			)}
			{hasResults && (
				<div className="search-result-summary" aria-live="polite">
					<span>{t("search.resultsFor", { query: submitted })}</span>
					<span className="count">{resultCount}</span>
				</div>
			)}
			{results && results.sessions.length > 0 && (
				<section className="board-section search-section">
					<header>
						<h2>{t("search.sessions")}</h2>
						<span className="count">{results.sessions.length}</span>
					</header>
					<ul className="search-hit-list">
						{results.sessions.map((hit) => (
							<li key={hit.sessionId} className="search-hit">
								<div className="search-hit-head">
									<span className="work-kind">{t("search.type.session")}</span>
									<Link className="search-hit-link" to={`/sessions/${hit.sessionId}`} title={hit.sessionId}>
										{hit.title ?? `#${hit.sessionId.slice(0, 8)}`}
									</Link>
									<span className="search-project">{hit.projectName}</span>
								</div>
								{hit.snippet && <p className="work-detail search-snippet">{hit.snippet}</p>}
								<div className="memory-meta search-meta">
									<span>{fmtTime(hit.matchedAt)}</span>
									{hit.turnPosition != null && <span>{t("search.turn", { n: hit.turnPosition })}</span>}
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
			{results && results.memories.length > 0 && (
				<section className="board-section search-section">
					<header>
						<h2>{t("search.memories")}</h2>
						<span className="count">{results.memories.length}</span>
					</header>
					<ul className="search-hit-list">
						{results.memories.map((hit) => (
							<li key={hit.memoryId} className="search-hit">
								<div className="search-hit-head">
									<span className="work-kind">{t(`memory.kind.${hit.kind}`)}</span>
									{hit.projectId != null ? (
										<Link className="search-hit-link" to={`/history/project/${hit.projectId}`}>
											{hit.projectName}
										</Link>
									) : (
										<span className="search-project">{hit.projectName}</span>
									)}
									{hit.scope === "global" && <span className="memory-status memory-status-pinned">{t("search.global")}</span>}
								</div>
								<p className="memory-content">{hit.content}</p>
								<div className="memory-meta search-meta">
									<span>{t(`memory.status.${hit.status}`)}</span>
									<span>{fmtTime(hit.lastSeenAt)}</span>
								</div>
							</li>
						))}
					</ul>
				</section>
			)}
		</div>
	);
}

function SearchIdle({ onExample }: { onExample: (query: string) => void }) {
	const { t } = useI18n();
	const examples = t("search.exampleQueries").split(",").map((part) => part.trim()).filter(Boolean);
	return (
		<section className="search-idle" aria-labelledby="search-idle-title">
			<div>
				<h2 id="search-idle-title">{t("search.idle.title")}</h2>
				<p>{t("search.idle.body")}</p>
			</div>
			<div className="search-examples" aria-label={t("search.examples")}>
				{examples.map((example) => (
					<button key={example} type="button" className="secondary" onClick={() => onExample(example)}>
						{example}
					</button>
				))}
			</div>
		</section>
	);
}
