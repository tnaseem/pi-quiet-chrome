/**
 * Output chrome: the status dot on replies, the orange working line, and the
 * breathing room around past prompts.
 *
 * Derived from pi-polish 0.1.1 (MIT, (c) 2026 Thomas van Dongen); see the
 * LICENSE file at the package root. The prompt markers (❯ before the input and
 * on past prompts) are deliberately left out, so past prompts keep their own
 * padding.
 */

import { AssistantMessageComponent, type ExtensionAPI, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";

// Blank lines above and below each past prompt
const USER_MESSAGE_PAD_Y = 1;
// Spaces between the chat edge and the prompt text
const USER_MESSAGE_PAD_X = 2;

const REPLY = "●";
const ORANGE = "\x1b[38;2;217;119;87m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const SPINNER = ["·", "✢", "✳", "✶", "✻", "✽", "✻", "✶", "✳", "✢"].map((f) => `${ORANGE}${f}${RESET}`);
const LEADING_ESCAPES = /^((?:\x1b\[[0-9;]*m|\x1b\][^\x07]*\x07)*) {2}/;
const OSC133_START = "\x1b]133;A\x07";
const OSC133_END = "\x1b]133;B\x07\x1b]133;C\x07";
const patched = Symbol.for("output-chrome.patched");

function markFirstLine(line: string, marker: string): string {
	return line.replace(LEADING_ESCAPES, (_m, esc: string) => `${esc}${marker} `);
}

function patchOnce(proto: any, method: string, wrap: (original: (...args: any[]) => any) => (...args: any[]) => any) {
	if (!proto || typeof proto[method] !== "function" || proto[method][patched]) return;
	const replacement: any = wrap(proto[method]);
	replacement[patched] = true;
	proto[method] = replacement;
}


/**
 * Gives past prompts breathing room, and overrides whatever padding an earlier
 * extension or setting may have applied.
 */
const patchUserMessageSpacing = (): void => {
  const proto = UserMessageComponent.prototype as any;
  if (proto.spacingPatched) return;
  proto.spacingPatched = true;

  // The padding lives on the Markdown child, which is re-created on every
  // rebuild(), so it is stamped after the chain runs on both hooks.
  const stamp = (self: any): void => {
    const md = self.children?.[0];
    if (!md || typeof md.paddingY !== "number") return;
    if (md.paddingY === USER_MESSAGE_PAD_Y && md.paddingX === USER_MESSAGE_PAD_X) return;
    md.paddingY = USER_MESSAGE_PAD_Y;
    md.paddingX = USER_MESSAGE_PAD_X;
    // The Markdown cache keys on text and width only, so a padding change alone
    // would be ignored without dropping it.
    md.invalidate?.();
  };

  const originalRebuild = proto.rebuild;
  proto.rebuild = function (this: any): void {
    originalRebuild.call(this);
    stamp(this);
  };

  const originalRender = proto.render;
  proto.render = function (this: any, width: number): string[] {
    stamp(this);
    return originalRender.call(this, width);
  };
};

export default function (pi: ExtensionAPI) {
	patchUserMessageSpacing();

	try {
		// Drop hidden thinking blocks entirely instead of rendering a "Thinking..." line plus spacers
		patchOnce(AssistantMessageComponent.prototype, "updateContent", (original) =>
			function (this: any, message: any, ...rest: any[]) {
				// Two columns of padding so reply text lines up behind the ● marker, like tool rows
				this.outputPad = Math.max(this.outputPad ?? 1, 2);
				if (!this.hideThinkingBlock) original.call(this, message, ...rest);
				else {
					original.call(this, { ...message, content: message.content.filter((c: any) => c.type !== "thinking") }, ...rest);
					this.lastMessage = message;
				}
				// Text blocks are the Markdown children without a default style; thinking blocks carry one
				for (const child of this.contentContainer?.children ?? []) {
					if (!(child instanceof Markdown) || (child as any).defaultTextStyle !== undefined || (child as any)[patched]) continue;
					const render = child.render.bind(child);
					child.render = (width: number) => {
						const lines: string[] = render(width);
						const first = lines.findIndex((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trim());
						if (first >= 0) lines[first] = markFirstLine(lines[first], REPLY);
						return lines;
					};
					(child as any)[patched] = true;
				}
			},
		);

	} catch (err) {
		console.error(`[output-chrome] could not patch message components: ${(err as Error).message}`);
	}

	// Orange working line: what pi is doing now, elapsed time and output tokens for this run
	let started = 0;
	let tokens = 0;
	let streamed = 0;
	let phase = "Thinking";
	let timer: NodeJS.Timeout | undefined;
	const fmtTokens = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
	const show = (ctx: any) => {
		const secs = Math.round((Date.now() - started) / 1000);
		const stats = `(${secs}s · ↓ ${fmtTokens(tokens + Math.round(streamed / 4))} tokens)`;
		ctx.ui.setWorkingMessage(`${ORANGE}${phase}…${RESET} ${DIM}${stats}${RESET}`);
	};
	const toolPhase = (name: string, args: any) => {
		const path = String(args?.path ?? "").split("/").pop();
		switch (name) {
			case "bash":
				return `Running ${String(args?.command ?? "").split("\n")[0].slice(0, 60)}`;
			case "read":
				return `Reading ${path}`;
			case "edit":
				return `Editing ${path}`;
			case "write":
				return `Writing ${path}`;
			case "grep":
			case "find":
				return `Searching for ${String(args?.pattern ?? "").slice(0, 40)}`;
			case "bg_run":
				return "Starting a background job";
			case "questionnaire":
				return "Waiting for your answer";
			default:
				return `Running ${name}`;
		}
	};
	pi.on("session_start", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingIndicator({ frames: SPINNER, intervalMs: 120 });
	});
	pi.on("agent_start", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		started = Date.now();
		tokens = 0;
		streamed = 0;
		phase = "Thinking";
		show(ctx);
		clearInterval(timer);
		timer = setInterval(() => show(ctx), 1000);
	});
	pi.on("message_update", async (event, ctx) => {
		if (!ctx.hasUI || event.message.role !== "assistant") return;
		const parts = (event.message as any).content ?? [];
		const last = parts[parts.length - 1];
		phase = last?.type === "text" ? "Responding" : last?.type === "toolCall" ? "Preparing a tool call" : "Thinking";
		streamed = parts.reduce((n: number, c: any) => n + (c.text?.length ?? c.thinking?.length ?? 0), 0);
	});
	pi.on("message_end", async (event) => {
		if (event.message.role !== "assistant") return;
		tokens += (event.message as any).usage?.output ?? 0;
		streamed = 0;
	});
	pi.on("tool_execution_start", async (event, ctx) => {
		if (!ctx.hasUI) return;
		phase = toolPhase(event.toolName, event.args);
		show(ctx);
	});
	pi.on("tool_execution_end", async () => {
		phase = "Thinking";
	});
	pi.on("agent_end", async (_event, ctx) => {
		clearInterval(timer);
		timer = undefined;
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
	pi.on("session_shutdown", async () => clearInterval(timer));
}
