import type { AssistantMessage, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Powerline-style status bar under the input.
 *
 * Left: provider, model and thinking level. Centre: git branch. Right: the
 * context-window bar and session cost.
 */

// Context bar sizing - the bar shrinks to the minimum in narrow terminals
const CONTEXT_BAR_WIDTH = 12;
const MIN_CONTEXT_BAR_WIDTH = 5;
// Blank space between the bar content and the terminal edges
const EDGE_PADDING = 2;

const fmtTokens = (n: number): string => {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", (event, ctx) => {
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsub = footerData.onBranchChange(() => tui.requestRender());
      return {
        dispose: unsub,
        invalidate() {},
        render(width: number): string[] {
          // Accumulate usage stats from the current session branch
          let totalCost = 0;
          let latestCacheHitRate: number | undefined;

          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              const m = entry.message as AssistantMessage;
              totalCost += m.usage.cost.total;
              const usage = m.usage;
              const total = usage.input + usage.cacheRead + usage.cacheWrite;
              if (total > 0) latestCacheHitRate = (usage.cacheRead / total) * 100;
            }
          }

          const model = ctx.model?.id?.split("/").pop() || "no-model";
          const provider = ctx.model?.provider || "provider";
          const level = pi.getThinkingLevel();
          const branch = footerData.getGitBranch() || "project";
          const contextUsage = ctx.getContextUsage();
          const usedTokens = contextUsage?.tokens ?? 0;
          const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;

          // percent is null when the token count is unknown, e.g. right after compaction
          const pctUsed = Math.min(
            100,
            Math.max(0, contextUsage?.percent ?? (contextWindow > 0 ? (usedTokens / contextWindow) * 100 : 0)),
          );
          const barColor = pctUsed >= 80 ? "error" : pctUsed >= 50 ? "warning" : "success";

          const bar = (size: number): string => {
            const filled = Math.round((pctUsed / 100) * size);
            return theme.fg(barColor, "█".repeat(filled)) + theme.fg("dim", "░".repeat(size - filled));
          };

          const contextSeg = (barSize: number): string =>
            theme.fg("muted", "ctx: [") +
            bar(barSize) +
            theme.fg("muted", "] ") +
            theme.fg("mdCode", `${fmtTokens(usedTokens)}/${fmtTokens(contextWindow)}`) +
            theme.fg(barColor, ` (${pctUsed.toFixed(0)}%)`);

          const leftParts = (): string[] => [
            theme.fg("accent", "[" + provider + "] " + model),
            theme.fg("success", level),
          ];

          const rightParts = (barSize: number): string[] => [
            contextSeg(barSize),
            theme.fg("dim", `$${totalCost.toFixed(2)}`),
          ];

          const centreStr = theme.fg("mdCode", " " + branch);

          const line = (barSize: number): string => {
            const edge = " ".repeat(EDGE_PADDING);
            const leftStr = edge + leftParts().join(" ");
            const rightStr = rightParts(barSize).join(" | ") + edge;
            const room = width - visibleWidth(leftStr) - visibleWidth(rightStr);
            const gap = room - visibleWidth(centreStr);

            // Too narrow for the branch - drop it rather than overlap the sides
            if (gap < 2) {
              return leftStr + " ".repeat(Math.max(0, room)) + rightStr;
            }

            const leftGap = Math.floor(gap / 2);
            return leftStr + " ".repeat(leftGap) + centreStr + " ".repeat(gap - leftGap) + rightStr;
          };

          // Shrink the bar before anything is cut off, so cost and percentage stay visible
          const overflow = visibleWidth(line(CONTEXT_BAR_WIDTH)) - width;
          const barSize = Math.max(MIN_CONTEXT_BAR_WIDTH, CONTEXT_BAR_WIDTH - Math.max(0, overflow));

          return [truncateToWidth(line(barSize), width), ""];
        },
      };
    });
  });
}
