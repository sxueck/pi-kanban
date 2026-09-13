/**
 * Minimal stand-in for pi-tui's Text component, covering only what pi-kanban
 * renders: static dim diagnostic lines. Matches Text's layout exactly — 1-space
 * margins, one blank line above and below, every line right-padded to the
 * viewport width (the differential renderer needs full-width lines).
 * Ceiling: overlong lines wrap at word boundaries under a simplified width
 * model (SGR escapes; common wide ranges for CJK/emoji) and wrapped
 * continuation lines do not re-emit the dim prefix. If that ever becomes
 * visible, revert to `new Text(...)` from @earendil-works/pi-tui.
 */

const SGR_PATTERN = /\x1b\[[0-9;]*m/g;
// Wide ranges per wcwidth: Hangul, CJK symbols/ideographs, fullwidth forms, emoji.
const WIDE_PATTERN = /[\u1100-\u115f\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\ufe30-\ufe4f\uff01-\uff60\uffe0-\uffe6\u{1f300}-\u{1faff}]/u;

function charWidth(code: number): number {
	return WIDE_PATTERN.test(String.fromCodePoint(code)) ? 2 : 1;
}

/** Visible width: ANSI SGR sequences count as 0, wide code points as 2. */
function visibleWidth(text: string): number {
	let width = 0;
	let i = 0;
	while (i < text.length) {
		SGR_PATTERN.lastIndex = i;
		const sgr = SGR_PATTERN.exec(text);
		if (sgr && sgr.index === i) {
			i += sgr[0].length;
			continue;
		}
		const code = text.codePointAt(i)!;
		width += charWidth(code);
		i += code > 0xffff ? 2 : 1;
	}
	return width;
}

/** Greedy word-boundary wrap; interior spacing of kept segments is preserved. */
function wrapLine(line: string, width: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	const out: string[] = [];
	let rest = line;
	while (visibleWidth(rest) > width) {
		let acc = 0;
		let breakAt = -1;
		let i = 0;
		while (i < rest.length) {
			SGR_PATTERN.lastIndex = i;
			const sgr = SGR_PATTERN.exec(rest);
			if (sgr && sgr.index === i) {
				i += sgr[0].length;
				continue;
			}
			const code = rest.codePointAt(i)!;
			const step = code > 0xffff ? 2 : 1;
			const cw = charWidth(code);
			if (acc + cw > width) {
				// An overflowing whitespace still terminates the line; trimEnd drops it.
				if (/\s/.test(String.fromCodePoint(code))) breakAt = i + step;
				break;
			}
			acc += cw;
			i += step;
			if (/\s/.test(String.fromCodePoint(code))) breakAt = i;
		}
		if (breakAt <= 0) {
			// No space within budget: hard-break at least one code point for progress.
			breakAt = i === 0 ? (rest.codePointAt(0)! > 0xffff ? 2 : 1) : i;
		}
		out.push(rest.slice(0, breakAt).trimEnd());
		rest = rest.slice(breakAt).trimStart();
		if (rest === "") break;
	}
	if (rest !== "") out.push(rest);
	return out;
}

interface StaticComponent {
	render(width: number): string[];
	invalidate(): void;
}

/** Static text panel; structurally assignable to pi-tui's Component. */
export function staticText(text: string): StaticComponent {
	return {
		render(width: number): string[] {
			if (text.trim() === "") return [];
			const paddingX = Math.min(1, Math.max(0, Math.floor((width - 1) / 2)));
			const contentWidth = Math.max(1, width - paddingX * 2);
			const margin = " ".repeat(paddingX);
			const body = text
				.replace(/\t/g, "   ")
				.split(/\r\n|\r|\n/)
				.flatMap((line) => wrapLine(line, contentWidth))
				.map((line) => {
					const padded = margin + line + margin;
					return padded + " ".repeat(Math.max(0, width - visibleWidth(padded)));
				});
			const blank = " ".repeat(width);
			return [blank, ...body, blank];
		},
		invalidate() {},
	};
}
