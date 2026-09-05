/**
 * Hand-drawn Notion-style line illustrations (thin strokes, minimal fills).
 * `illustration` floats slowly; `.breathe` elements fade in and out.
 */
const STROKE = "#37352f";
const FAINT = "rgba(55,53,47,0.35)";

export function EmptyBoardIllustration() {
	return (
		<svg className="illustration" width="180" height="130" viewBox="0 0 180 130" fill="none" role="img" aria-label="empty board">
			{/* board frame */}
			<rect x="30" y="18" width="120" height="88" rx="6" stroke={STROKE} strokeWidth="2" />
			<line x1="70" y1="18" x2="70" y2="106" stroke={FAINT} strokeWidth="1.5" />
			<line x1="110" y1="18" x2="110" y2="106" stroke={FAINT} strokeWidth="1.5" />
			{/* empty column cards (dashed = nothing there) */}
			<rect x="38" y="28" width="24" height="16" rx="3" stroke={FAINT} strokeWidth="1.5" strokeDasharray="3 3" />
			<rect x="38" y="50" width="24" height="16" rx="3" stroke={FAINT} strokeWidth="1.5" strokeDasharray="3 3" />
			<rect x="78" y="28" width="24" height="16" rx="3" stroke={FAINT} strokeWidth="1.5" strokeDasharray="3 3" />
			<rect x="118" y="28" width="24" height="16" rx="3" stroke={FAINT} strokeWidth="1.5" strokeDasharray="3 3" />
			{/* sparkles */}
			<g className="breathe" stroke={STROKE} strokeWidth="2" strokeLinecap="round">
				<path d="M162 40v10M157 45h10" />
			</g>
			<g className="breathe" stroke={STROKE} strokeWidth="1.5" strokeLinecap="round" style={{ animationDelay: "0.8s" }}>
				<path d="M18 70v8M14 74h8" />
			</g>
			<circle className="breathe" cx="160" cy="92" r="3" stroke={STROKE} strokeWidth="1.5" style={{ animationDelay: "1.6s" }} />
		</svg>
	);
}

export function NoApprovalsIllustration() {
	return (
		<svg className="illustration" width="150" height="120" viewBox="0 0 150 120" fill="none" role="img" aria-label="nothing pending">
			{/* shield */}
			<path
				d="M75 14l38 12v30c0 24-16 42-38 50-22-8-38-26-38-50V26l38-12z"
				stroke={STROKE}
				strokeWidth="2"
				strokeLinejoin="round"
			/>
			{/* check */}
			<path d="M58 58l12 12 22-24" stroke="#448361" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
			{/* confetti */}
			<g className="breathe" stroke={STROKE} strokeWidth="1.5" strokeLinecap="round">
				<path d="M26 20v8M22 24h8" />
			</g>
			<circle className="breathe" cx="126" cy="26" r="3" stroke={STROKE} strokeWidth="1.5" style={{ animationDelay: "0.6s" }} />
			<g className="breathe" stroke={STROKE} strokeWidth="1.5" strokeLinecap="round" style={{ animationDelay: "1.2s" }}>
				<path d="M128 84v7M124.5 87.5h7" />
			</g>
		</svg>
	);
}

export function EmptyHistoryIllustration() {
	return (
		<svg className="illustration" width="170" height="120" viewBox="0 0 170 120" fill="none" role="img" aria-label="no projects">
			{/* folder */}
			<path
				d="M22 40a4 4 0 014-4h34l10 10h74a4 4 0 014 4v52a4 4 0 01-4 4H26a4 4 0 01-4-4V40z"
				stroke={STROKE}
				strokeWidth="2"
				strokeLinejoin="round"
			/>
			{/* papers peeking out */}
			<rect x="56" y="20" width="56" height="40" rx="3" stroke={FAINT} strokeWidth="1.5" transform="rotate(-4 84 40)" />
			<rect x="60" y="26" width="56" height="40" rx="3" stroke={FAINT} strokeWidth="1.5" transform="rotate(3 88 46)" />
			{/* lines on folder */}
			<line x1="34" y1="66" x2="80" y2="66" stroke={FAINT} strokeWidth="1.5" strokeLinecap="round" />
			<line x1="34" y1="78" x2="66" y2="78" stroke={FAINT} strokeWidth="1.5" strokeLinecap="round" />
			{/* dust sparkle */}
			<g className="breathe" stroke={STROKE} strokeWidth="1.5" strokeLinecap="round">
				<path d="M148 22v8M144 26h8" />
			</g>
		</svg>
	);
}

export function NotFoundIllustration() {
	return (
		<svg className="illustration" width="150" height="120" viewBox="0 0 150 120" fill="none" role="img" aria-label="page not found">
			{/* page */}
			<rect x="34" y="16" width="66" height="84" rx="5" stroke={STROKE} strokeWidth="2" />
			<line x1="46" y1="32" x2="86" y2="32" stroke={FAINT} strokeWidth="1.5" strokeLinecap="round" />
			<line x1="46" y1="44" x2="78" y2="44" stroke={FAINT} strokeWidth="1.5" strokeLinecap="round" />
			<line x1="46" y1="56" x2="82" y2="56" stroke={FAINT} strokeWidth="1.5" strokeLinecap="round" />
			{/* magnifier */}
			<circle cx="96" cy="76" r="18" stroke={STROKE} strokeWidth="2.5" />
			<line x1="109" y1="89" x2="122" y2="102" stroke={STROKE} strokeWidth="2.5" strokeLinecap="round" />
			{/* question mark inside lens */}
			<path
				className="breathe"
				d="M92 72a5 5 0 019-3c1.5 2 .5 4-2 5.5-1.6 1-2 2-2 4"
				stroke={STROKE}
				strokeWidth="2"
				strokeLinecap="round"
			/>
			<circle cx="96" cy="83" r="1.4" fill={STROKE} />
		</svg>
	);
}

export function GateIllustration() {
	return (
		<svg className="illustration" width="150" height="110" viewBox="0 0 150 110" fill="none" role="img" aria-label="pi-kanban">
			{/* mini kanban */}
			<rect x="25" y="12" width="100" height="70" rx="6" stroke={STROKE} strokeWidth="2" />
			<line x1="58" y1="12" x2="58" y2="82" stroke={FAINT} strokeWidth="1.5" />
			<line x1="92" y1="12" x2="92" y2="82" stroke={FAINT} strokeWidth="1.5" />
			<rect x="32" y="22" width="19" height="13" rx="2.5" fill="#faebdd" stroke={STROKE} strokeWidth="1.5" />
			<rect x="65" y="22" width="19" height="13" rx="2.5" fill="#edf3ec" stroke={STROKE} strokeWidth="1.5" />
			<rect x="65" y="41" width="19" height="13" rx="2.5" stroke={STROKE} strokeWidth="1.5" />
			<rect x="99" y="22" width="19" height="13" rx="2.5" fill="#fbf3db" stroke={STROKE} strokeWidth="1.5" />
			{/* lock */}
			<g>
				<rect x="63" y="70" width="24" height="20" rx="4" fill="#37352f" />
				<path d="M68 70v-6a7 7 0 0114 0v6" stroke={STROKE} strokeWidth="2.5" />
				<circle cx="75" cy="79" r="2.5" fill="#fff" />
				<line x1="75" y1="81" x2="75" y2="85" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
			</g>
			{/* sparkle */}
			<g className="breathe" stroke={STROKE} strokeWidth="1.5" strokeLinecap="round">
				<path d="M134 20v8M130 24h8" />
			</g>
		</svg>
	);
}
