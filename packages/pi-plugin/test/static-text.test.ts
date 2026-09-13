import assert from "node:assert/strict";
import { staticText } from "../src/static-text.js";

// Short line: 1-space margins, blank lines above/below, right-padded to width.
{
	const lines = staticText("hi").render(20);
	assert.equal(lines.length, 3);
	assert.equal(lines[0], " ".repeat(20));
	assert.equal(lines[1], " hi " + " ".repeat(16));
	assert.equal(lines[2], " ".repeat(20));
}

// Multi-line text keeps alignment and blank padding between lines.
{
	const lines = staticText("  server      ws://kanban:8787 — connected\n  session     none").render(60);
	assert.equal(lines.length, 4);
	assert.equal(lines[1], "   server      ws://kanban:8787 — connected" + " ".repeat(60 - 43));
	assert.equal(lines[2], "   session     none" + " ".repeat(60 - 19));
}

// Overlong line wraps at a word boundary; continuation has no leading space.
// width 12 -> contentWidth 10: "alpha beta" fills it exactly; the rest wraps.
{
	const lines = staticText("alpha beta gamma delta").render(12);
	assert.deepEqual(
		lines.slice(1, -1).map((l) => l.trimEnd()),
		[" alpha beta", " gamma", " delta"],
	);
}

// Interior alignment spacing survives when the line wraps (24 > 18).
{
	const lines = staticText("  cache       2 projects").render(20);
	assert.deepEqual(
		lines.slice(1, -1).map((l) => l.trimEnd()),
		["   cache       2", " projects"],
	);
}

// ANSI SGR sequences occupy no width and pass through unbroken.
{
	const dim = "\x1b[2mhello\x1b[0m";
	const lines = staticText(dim).render(20);
	assert.equal(lines[1], " " + dim + " " + " ".repeat(13));
}

// CJK counts as width 2, so padding lands at the right edge.
{
	const lines = staticText("你好").render(6);
	// contentWidth 4 == visible width, so no wrap; 1+4+1 = 6.
	assert.equal(lines[1], " 你好 ");
	assert.equal(staticText("你好").render(5).length, 4); // 4 > contentWidth 3: wraps per char
}

// Whitespace-only text renders nothing, matching pi-tui's Text.
{
	assert.deepEqual(staticText("").render(20), []);
	assert.deepEqual(staticText("   ").render(20), []);
}

// invalidate() is a no-op but must exist for the Component contract.
{
	const component = staticText("x");
	assert.equal(typeof component.invalidate, "function");
	component.invalidate();
}

console.log("static-text: all checks passed");
