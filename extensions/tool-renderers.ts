/**
 * Tool row renderers: folded tool calls with a status dot, and file edits shown
 * as diff previews.
 *
 * Derived from pi-polish 0.1.1 (MIT, (c) 2026 Thomas van Dongen); see the
 * LICENSE file at the package root. Shiki syntax highlighting was removed: the
 * diff text now comes from pi's own highlighter, and the word diff is local.
 */

import { relative } from "node:path";
import {
	getLanguageFromPath,
	highlightCode,
	keyHint,
	type ExtensionAPI,
	type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { type Component, Container, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const MARK = "●";

// Comments come out of the highlighter in a mid grey that reads faint on the
// diff bands, so they are lifted to this lighter tone
const COMMENT_COLOR = "\x1b[38;2;140;150;178m";

// Some models default to shell heredocs and sed even with pi's built-in guidance; these make the file tools the default
const FILE_TOOL_GUIDELINES: Record<string, string[]> = {
	read: ["Use read to view file contents instead of cat, head, tail or sed -n in bash."],
	edit: [
		"Use edit to change existing files instead of bash: never modify files with sed -i, perl -pi, python or node scripts, or shell redirection.",
	],
	write: [
		"Use write to create new files or fully rewrite small ones instead of bash: never create files with cat <<EOF, echo or printf redirection, tee, or python scripts.",
		"write creates missing parent directories itself, so call it directly instead of combining mkdir -p with a heredoc in bash.",
	],
};

/** The diff lines out of a result: pi sends " 1 text" / "-2 text" / "+2 text". */
function readDiff(result: any): string[] {
	return String(result?.details?.diff ?? "")
		.split("\n")
		.filter((line) => line.length > 0);
}

const DIFF_PREVIEW_LINES = 16;
// Columns of clearance between the diff and either terminal edge
const DIFF_MARGIN_X = 2;
const BG_RESET = "\x1b[49m";
const FG_RESET = "\x1b[39m";

type Kind = "bash" | "read" | "search" | "list";
const KIND_OF: Record<string, Kind> = { bash: "bash", read: "read", grep: "search", find: "search", ls: "list" };
const VERBS: Record<Kind, [done: string, running: string, one: string, many: string]> = {
	bash: ["Ran", "Running", "shell command", "shell commands"],
	read: ["Read", "Reading", "file", "files"],
	search: ["Searched", "Searching", "pattern", "patterns"],
	list: ["Listed", "Listing", "directory", "directories"],
};

interface Member {
	id: string;
	kind: Kind;
	label: string;
	done: boolean;
	error: boolean;
}

interface Group {
	members: Member[];
	started: number;
	ended?: number;
	timer?: NodeJS.Timeout;
}

type Result = { content: Array<{ type: string; text?: string }>; details?: unknown };

function resultText(result: Result): string {
	return result.content
		.filter((c) => c.type === "text")
		.map((c) => c.text ?? "")
		.join("\n");
}

function shortPath(path: unknown, cwd: string): string {
	const p = String(path ?? "?");
	const rel = relative(cwd, p);
	return rel && !rel.startsWith("..") && !rel.startsWith("/") ? rel : p;
}

function label(toolName: string, args: any, cwd: string): string {
	switch (toolName) {
		case "bash":
			return `$ ${String(args?.command ?? "").split("\n")[0]}`;
		case "read":
			return `Read ${shortPath(args?.path, cwd)}`;
		case "grep":
			return `Search "${args?.pattern ?? ""}"${args?.path ? ` in ${shortPath(args.path, cwd)}` : ""}`;
		case "find":
			return `Find "${args?.pattern ?? ""}"${args?.path ? ` in ${shortPath(args.path, cwd)}` : ""}`;
		default:
			return `List ${args?.path ? shortPath(args.path, cwd) : "."}`;
	}
}

function summary(group: Group, running: boolean): string {
	const counts = new Map<Kind, number>();
	for (const m of group.members) counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
	const parts = [...counts].map(([kind, n]) => {
		const [done, active, one, many] = VERBS[kind];
		return `${(running ? active : done).toLowerCase()} ${n} ${n === 1 ? one : many}`;
	});
	const text = parts.join(", ");
	return text.charAt(0).toUpperCase() + text.slice(1);
}

/**
 * Lifts comment greys in a highlighted line to COMMENT_COLOR.
 * The highlighter emits one `38;2;r;g;b` escape per token, so a colour that is
 * near-grey and mid-luminance is a comment; swapping it is a string match,
 * which avoids re-tokenising the code just to restyle one token type.
 */
const liftCommentColor = (line: string): string =>
	line.replace(/\x1b\[38;2;(\d+);(\d+);(\d+)m/g, (match, r, g, b) => {
		const [red, green, blue] = [Number(r), Number(g), Number(b)];
		const isGrey = Math.max(red, green, blue) - Math.min(red, green, blue) < 24;
		const isMidTone = red > 90 && red < 175;
		return isGrey && isMidTone ? COMMENT_COLOR : match;
	});

function expandedBody(theme: any, text: string, maxLines = 60): string {
	const lines = text.split("\n");
	const shown = lines.slice(0, maxLines).join("\n");
	const extra = lines.length > maxLines ? `\n${theme.fg("dim", `... ${lines.length - maxLines} more lines`)}` : "";
	return "  " + theme.fg("toolOutput", shown).replace(/\n/g, "\n  ") + extra;
}

/**
 * Diff band and gutter colours, matched to the active pi theme. Only the bands
 * are drawn here; the code text itself comes from pi's own highlighter.
 *
 * Dark bands keep Tokyo Night's hues saturated rather than washing them out
 * into a grey base: dark-but-clearly-green for additions, dark-but-clearly-red
 * for removals. They stay dark enough for the highlighter's comment grey
 * (#737aa2) to read on top - comments are the dimmest text in a diff.
 */
const PALETTES = {
	dark: {
		addedBg: "\x1b[48;2;22;56;27m",
		removedBg: "\x1b[48;2;68;26;31m",
		// Bands for the words that changed within a replaced line. Kept close to the
		// line band so the lifted comment text still reads on top of them
		addedWordBg: "\x1b[48;2;32;76;37m",
		removedWordBg: "\x1b[48;2;86;32;38m",
		// Line numbers and +/- signs tinted to match their band, like Claude Code, instead of dim grey
		addedGutter: "\x1b[38;2;158;206;106m",
		removedGutter: "\x1b[38;2;247;118;142m",
	},
	light: {
		addedBg: "\x1b[48;2;226;248;229m",
		removedBg: "\x1b[48;2;252;230;227m",
		addedWordBg: "\x1b[48;2;178;236;188m",
		removedWordBg: "\x1b[48;2;250;188;183m",
		addedGutter: "\x1b[38;2;52;130;74m",
		removedGutter: "\x1b[38;2;176;64;70m",
	},
};
type Palette = (typeof PALETTES)["dark"];

const paletteFor = (theme: any): Palette => (theme?.appearance === "light" ? PALETTES.light : PALETTES.dark);

type Span = [number, number];

/**
 * Word-level diff of two lines, as runs on each side. A minimal longest-common-
 * subsequence over tokens: enough to mark the words that changed, without
 * pulling in a dependency for it.
 */
const wordDiff = (before: string, after: string): Array<{ value: string; removed?: boolean; added?: boolean }> => {
	const tokens = (s: string) => s.match(/\s+|\w+|[^\s\w]+/g) ?? [];
	const a = tokens(before);
	const b = tokens(after);
	// LCS table, then walk back through it to emit the runs
	const table = Array.from({ length: a.length + 1 }, (): number[] => new Array(b.length + 1).fill(0));
	for (let i = a.length - 1; i >= 0; i--) {
		for (let j = b.length - 1; j >= 0; j--) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const runs: Array<{ value: string; removed?: boolean; added?: boolean }> = [];
	const push = (value: string, flag?: "removed" | "added") => {
		const last = runs[runs.length - 1];
		if (last && (last.removed ? "removed" : last.added ? "added" : undefined) === flag) last.value += value;
		else runs.push(flag ? { value, [flag]: true } : { value });
	};
	let [i, j] = [0, 0];
	while (i < a.length && j < b.length) {
		if (a[i] === b[j]) {
			push(a[i]);
			i++;
			j++;
		} else if (table[i + 1][j] >= table[i][j + 1]) push(a[i++], "removed");
		else push(b[j++], "added");
	}
	while (i < a.length) push(a[i++], "removed");
	while (j < b.length) push(b[j++], "added");
	return runs;
};

/**
 * The changed words of a replaced line, as column spans on each side (word-level). Changes separated only by
 * whitespace merge into one span. Undefined when the lines share too little for word highlighting to mean anything.
 */
function changedSpans(before: string, after: string): [Span[], Span[]] | undefined {
	const removed: Span[] = [];
	const added: Span[] = [];
	let [b, a, same] = [0, 0, 0];
	const push = (spans: Span[], start: number, end: number) => {
		const last = spans[spans.length - 1];
		if (last && /^\s*$/.test((spans === removed ? before : after).slice(last[1], start))) last[1] = end;
		else spans.push([start, end]);
	};
	for (const part of wordDiff(before, after)) {
		const n = part.value.length;
		if (part.removed) push(removed, b, (b += n));
		else if (part.added) push(added, a, (a += n));
		else {
			b += n;
			a += n;
			same += part.value.trim().length;
		}
	}
	if (same < 0.3 * Math.max(before.trim().length, after.trim().length)) return undefined;
	return [removed, added];
}

/** Whether the character at `col` of an ANSI line is styled in a near-grey comment colour. */
const isCommentColor = (line: string, col: number): boolean => {
	let seen = 0;
	let color = "";
	for (let i = 0; i < line.length && seen <= col; ) {
		const esc = /^\x1b\[38;2;(\d+);(\d+);(\d+)m/.exec(line.slice(i));
		if (esc) {
			color = esc[0];
			i += esc[0].length;
			continue;
		}
		if (/^\x1b\[[0-9;]*m/.test(line.slice(i))) {
			i += /^\x1b\[[0-9;]*m/.exec(line.slice(i))![0].length;
			continue;
		}
		seen++;
		i++;
	}
	const rgb = /38;2;(\d+);(\d+);(\d+)/.exec(color);
	if (!rgb) return false;
	const [r, g, b] = [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
	return Math.max(r, g, b) - Math.min(r, g, b) < 24 && r > 90 && r < 175;
};

/**
 * Recolours the given spans of an ANSI line to `color`, but only where they are already near-grey
 * (comments) - keywords and literals keep their own colour over the word band, as they do elsewhere.
 * Both loops skip escapes without advancing `col`, so visible columns stay aligned with `spans`.
 */
function brightenCommentSpans(line: string, spans: Span[], color: string): string {
	let out = "";
	let i = 0;
	let col = 0;
	for (const [start, end] of spans) {
		// Leave saturated tokens alone; only near-grey comment text is lifted
		if (!isCommentColor(line, start)) continue;
		// Walk the styled line to the span start, keeping its existing escapes
		while (col < start && i < line.length) {
			const esc = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
			if (esc) {
				out += esc[0];
				i += esc[0].length;
				continue;
			}
			out += line[i++];
			col++;
		}
		// Emit the span as bare text in the new colour, stepping over its escapes
		out += color;
		for (let n = start; n < end;) {
			const esc = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
			if (esc) {
				i += esc[0].length;
				continue;
			}
			out += line[i++];
			n++;
			col++;
		}
		out += "\x1b[39m";
	}
	while (i < line.length) out += line[i++];
	return out;
}
function withBackground(line: string, spans: Span[], on: string, off: string): string {
	const marked = (col: number) => spans.some(([start, end]) => col >= start && col < end);
	let out = "";
	let col = 0;
	let inside = false;
	for (let i = 0; i < line.length; ) {
		const esc = /^\x1b\[[0-9;]*m/.exec(line.slice(i));
		if (esc) {
			out += esc[0] + (inside && /^\x1b\[0?m$/.test(esc[0]) ? on : "");
			i += esc[0].length;
			continue;
		}
		const want = marked(col);
		if (want !== inside) {
			out += want ? on : off;
			inside = want;
		}
		out += line[i++];
		col++;
	}
	return inside ? out + off : out;
}

/**
 * Renders pi's "+12 text" / "-12 text" / " 12 text" diff lines with syntax highlighting, added and
 * removed lines as full-width coloured bands.
 */
class DiffView implements Component {
	private highlighted: string[];
	private palette: Palette;
	private hasOpposite: boolean;

	constructor(
		private lines: string[],
		private theme: any,
		private footer?: string,
		path = "",
	) {
		const palette = (this.palette = paletteFor(theme));
		// A diff with only one sign is a new file or a full rewrite, not a change
		this.hasOpposite = lines.some((line) => line[0] === "-") && lines.some((line) => line[0] === "+");
		// Highlight all bodies as one snippet so multi-line strings and docstrings colour correctly
		const bodies = lines.map((line) => (/^[+\- ]\s*\d*\s(.*)$/.exec(line)?.[1] ?? line.slice(1)).replace(/\t/g, "    "));
		let highlighted: string[] = [];
		try {
			const code = bodies.join("\n");
			const lang = getLanguageFromPath(path);
			highlighted = lang ? highlightCode(code, lang).map(liftCommentColor) : [];
		} catch {
			highlighted = [];
		}
		this.highlighted = highlighted.length === bodies.length ? highlighted : bodies.map((b) => theme.fg("toolTitle", b));

		// Pair each run of removed lines with the added run right after it, line by line, and mark the changed words
		for (let i = 0; i < lines.length; ) {
			if (lines[i][0] !== "-") {
				i++;
				continue;
			}
			let removedEnd = i;
			while (removedEnd < lines.length && lines[removedEnd][0] === "-") removedEnd++;
			let addedEnd = removedEnd;
			while (addedEnd < lines.length && lines[addedEnd][0] === "+") addedEnd++;
			for (let k = 0; k < Math.min(removedEnd - i, addedEnd - removedEnd); k++) {
				const [r, a] = [i + k, removedEnd + k];
				const spans = changedSpans(bodies[r], bodies[a]);
				if (!spans) continue;
				this.highlighted[r] = withBackground(this.highlighted[r], spans[0], palette.removedWordBg, palette.removedBg);
				this.highlighted[a] = withBackground(this.highlighted[a], spans[1], palette.addedWordBg, palette.addedBg);
				// Comments are the dimmest text, so lift the ones inside a highlighted word:
				// the brighter band alone would otherwise bury them
				this.highlighted[r] = brightenCommentSpans(this.highlighted[r], spans[0], COMMENT_COLOR);
				this.highlighted[a] = brightenCommentSpans(this.highlighted[a], spans[1], COMMENT_COLOR);
			}
			i = addedEnd;
		}
	}

	render(width: number): string[] {
		const { addedBg, removedBg, addedGutter, removedGutter } = this.palette;
		const out = this.lines.map((line, i) => {
			const sign = line[0];
			const num = /^[+\- ](\s*\d*)\s/.exec(line)?.[1] ?? "";
			const gutterText = `    ${num} ${sign === " " ? " " : sign} `;
			const gutter = sign === "+" ? addedGutter + gutterText + FG_RESET : sign === "-" ? removedGutter + gutterText + FG_RESET : this.theme.fg("dim", gutterText);
			// The margin keeps the bands off the edges, matching them on both sides
			const inner = Math.max(10, width - DIFF_MARGIN_X * 2);
			const text = truncateToWidth(gutter + this.highlighted[i], inner);
			// Tint every changed line, but not an all-"+"/all-"-" diff: a new
			// file would glow as one solid slab. Colour there comes from the gutter.
			const margin = " ".repeat(DIFF_MARGIN_X);
			if (sign === " " || !this.hasOpposite) return margin + text;
			const bg = sign === "+" ? addedBg : removedBg;
			const pad = " ".repeat(Math.max(0, inner - visibleWidth(text)));
			// Highlighter resets would end the band early, so restore the background after each one
			return margin + bg + text.replace(/\x1b\[0?m/g, (m) => m + bg) + pad + BG_RESET + margin;
		});
		if (this.footer) out.push(truncateToWidth(this.footer, width));
		return out;
	}

	invalidate(): void {}
}

function lineCount(n: number): string {
	return `${n} line${n === 1 ? "" : "s"}`;
}

function errorText(theme: any, text: string, expanded: boolean): Text {
	const lines = text.trim().split("\n");
	const body = expanded ? lines.join("\n    ") : lines[0] + (lines.length > 1 ? theme.fg("dim", `  (${keyHint("app.tools.expand", "details")})`) : "");
	return new Text(theme.fg("error", `  └ ${body}`), 0, 0);
}

function empty() {
	return new Container();
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();
	const groupOf = new Map<string, Group>();
	const rowInvalidate = new Map<string, () => void>();
	let current: Group | undefined;
	let live = false;
	// False until session_start has grouped the history; pi draws old rows before that event
	let ready = false;

	const refresh = (group: Group) => {
		for (const m of group.members) rowInvalidate.get(m.id)?.();
	};

	const tick = (group: Group) => {
		const running = group.members.some((m) => !m.done);
		if (running && !group.timer) group.timer = setInterval(() => rowInvalidate.get(group.members[0].id)?.(), 1000);
		if (!running && group.timer) {
			clearInterval(group.timer);
			group.timer = undefined;
			group.ended = Date.now();
		}
	};

	const assign = (id: string, toolName: string, args: unknown, done = false, error = false): Group => {
		current ??= { members: [], started: Date.now() };
		current.members.push({ id, kind: KIND_OF[toolName], label: label(toolName, args, cwd), done, error });
		groupOf.set(id, current);
		return current;
	};

	const reset = () => {
		for (const g of new Set(groupOf.values())) if (g.timer) clearInterval(g.timer);
		groupOf.clear();
		current = undefined;
		ready = false;
	};

	// Rebuild groups for history so resumed sessions collapse the same way
	pi.on("session_start", async (_event, ctx) => {
		reset();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message as any;
			if (msg.role === "user") current = undefined;
			if (msg.role !== "assistant") continue;
			for (const part of msg.content ?? []) {
				if (part.type === "text" && part.text.trim()) current = undefined;
				if (part.type !== "toolCall") continue;
				if (KIND_OF[part.name]) assign(part.id, part.name, part.arguments, true);
				else current = undefined;
			}
		}
		current = undefined;
		ready = true;
		for (const invalidate of rowInvalidate.values()) invalidate();
		// History rows were drawn before they were grouped; a full redraw clears their stale lines
		if (ctx.hasUI) {
			ctx.ui.setWidget("tool-renderers-redraw", (tui) => {
				setTimeout(() => {
					ctx.ui.setWidget("tool-renderers-redraw", undefined);
					tui.requestRender(true);
				}, 0);
				return new Container();
			});
		}
	});

	pi.on("agent_start", async () => {
		live = true;
		current = undefined;
	});
	pi.on("agent_end", async () => {
		live = false;
		current = undefined;
	});
	pi.on("message_end", async (event) => {
		const msg = event.message as any;
		if (msg.role === "assistant" && (msg.content ?? []).some((c: any) => c.type === "text" && c.text.trim())) current = undefined;
	});
	pi.on("tool_execution_start", async (event) => {
		if (!KIND_OF[event.toolName]) {
			current = undefined;
			return;
		}
		const group = assign(event.toolCallId, event.toolName, event.args);
		tick(group);
		refresh(group);
	});
	pi.on("tool_execution_end", async (event) => {
		const group = groupOf.get(event.toolCallId);
		const member = group?.members.find((m) => m.id === event.toolCallId);
		if (!group || !member) return;
		member.done = true;
		member.error = event.isError;
		tick(group);
		refresh(group);
	});
	pi.on("session_shutdown", async () => reset());

	/** Collapsed rendering for a grouped tool row; the group's first row draws the whole group. */
	const renderGrouped = (toolCallId: string, theme: any, context: any): Component | undefined => {
		rowInvalidate.set(toolCallId, context.invalidate);
		if (context.expanded) return undefined;
		const group = groupOf.get(toolCallId);
		// Live rows wait for tool_execution_start to place them; history rows without a group render alone
		if (!group) return live || !ready ? empty() : undefined;
		if (group.members[0].id !== toolCallId) return empty();

		const running = group.members.some((m) => !m.done);
		const failed = group.members.filter((m) => m.error).length;
		const failNote = failed ? theme.fg("error", ` · ${failed} failed`) : "";
		if (running) {
			const secs = Math.round((Date.now() - group.started) / 1000);
			const active = [...group.members].reverse().find((m) => !m.done) ?? group.members[group.members.length - 1];
			const head = theme.fg("accent", `${MARK} `) + theme.fg("toolTitle", `${summary(group, true)}…`) + theme.fg("dim", ` · ${secs}s`) + failNote;
			return new Text(`${head}\n${theme.fg("dim", `  └ ${active.label}`)}`, 0, 0);
		}
		const hint = theme.fg("dim", `  (${keyHint("app.tools.expand", "expand")})`);
		const mark = theme.fg(failed ? "error" : "success", `${MARK} `);
		const text = group.members.length === 1 ? group.members[0].label : summary(group, false);
		return new Text(mark + theme.fg("toolTitle", text) + failNote + hint, 0, 0);
	};

	// The ● carries the status, like Claude Code: dim while arguments stream, accent while running, green or red when done.
	// History rows redrawn after /reload have no execution state, so they count as done.
	const dot = (theme: any, context: { isPartial?: boolean; isError?: boolean; executionStarted?: boolean }) => {
		if (context.isError) return theme.fg("error", `${MARK} `);
		if (context.executionStarted && context.isPartial) return theme.fg("accent", `${MARK} `);
		if (!context.executionStarted && live) return theme.fg("dim", `${MARK} `);
		return theme.fg("success", `${MARK} `);
	};

	const groupedTool = (toolName: string): ToolRenderers => ({
		renderShell: "self",
		renderCall(args: any, theme, context) {
			const grouped = renderGrouped(context.toolCallId, theme, context);
			if (grouped) return grouped;
			const text = truncateToWidth(label(toolName, args, cwd), 400);
			return new Text(dot(theme, context) + theme.fg("toolTitle", text), 0, 0);
		},
		renderResult(result, { expanded }, theme) {
			if (!expanded) return empty();
			return new Text(expandedBody(theme, resultText(result as Result)), 0, 0);
		},
	});

	/** An edit or write row: "Update path" or "Write path", then a stats line and a diff preview. */
	const fileTool = (verb: string, diffOf: (result: any, args: any) => [stats: string, lines: string[]]): ToolRenderers => ({
		renderShell: "self",
		renderCall(args: any, theme, context) {
			return new Text(dot(theme, context) + theme.fg("toolTitle", `${verb} ${shortPath(args?.path, cwd)}`), 0, 0);
		},
		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return empty();
			if (context.isError) return errorText(theme, resultText(result as Result), expanded);
			const args = context.args as any;
			const [stats, lines] = diffOf(result, args);
			const shown = expanded ? lines : lines.slice(0, DIFF_PREVIEW_LINES);
			const more = lines.length - shown.length;
			const footer = more > 0 ? theme.fg("dim", `    … +${more} lines (${keyHint("app.tools.expand", "expand")})`) : undefined;
			const box = new Container();
			box.addChild(new Text(theme.fg("dim", `  └ ${stats}`), 0, 0));
			box.addChild(new DiffView(shown, theme, footer, String(args?.path ?? "")));
			return box;
		},
	});

	const renderers: Record<string, ToolRenderers> = {
		bash: groupedTool("bash"),
		read: groupedTool("read"),
		grep: groupedTool("grep"),
		find: groupedTool("find"),
		ls: groupedTool("ls"),
		edit: fileTool("Update", (result) => {
			const diff = readDiff(result);
			const added = diff.filter((l) => l.startsWith("+")).length;
			const removed = diff.filter((l) => l.startsWith("-")).length;
			return [`Added ${lineCount(added)}, removed ${lineCount(removed)}`, diff];
		}),
		// A new file shows as added lines, previewed like an edit's diff
		write: fileTool("Write", (_result, args) => {
			const lines = String(args?.content ?? "").replace(/\n$/, "").split("\n");
			const width = String(lines.length).length;
			return [`Wrote ${lineCount(lines.length)}`, lines.map((line, i) => `+${String(i + 1).padStart(width)} ${line}`)];
		}),
	};
	// Only the drawing changes: pi's own tools keep running, with their own schema and on/off state
	pi.registerToolRenderer((toolName, next) => renderers[toolName] ?? next());

	// pi only lists a tool's guidelines while the tool is on
	pi.on("before_agent_start", async (event) => {
		const guidelines = event.systemPromptOptions.toolGuidelines;
		for (const [name, rules] of Object.entries(FILE_TOOL_GUIDELINES)) guidelines[name] = [...(guidelines[name] ?? []), ...rules];
	});
}
