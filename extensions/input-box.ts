import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Rounded-box input field.
 *
 * Wraps pi's editor in a frame with a blue-grey border that is pinned
 * regardless of theme, so the input reads as a distinct surface.
 */

// Cursor/text inset from the left edge of the box (0 = flush with the border)
const INNER_PADDING = 1;
// Margin outside the box, against the terminal edges
const OUTER_PADDING = 1;
// Permanent blue-grey border, locked regardless of theme
const BORDER_COLOR = "\x1b[38;2;78;86;122m";

export default function (pi: ExtensionAPI) {
  /**
   * Custom Editor implementation that wraps the standard input field
   * in a rounded box-drawing frame.
   */
  class BoxedEditor extends CustomEditor {
    private forcedBorderColor = (s: string): string => `${BORDER_COLOR}${s}\x1b[0m`;

    constructor(tui: any, theme: any, keybindings: any) {
      super(tui, theme, keybindings, { paddingX: INNER_PADDING });

      // Pin the text inset. The app's own editorPaddingX setting and any other
      // extension assign paddingX on every render, which would override ours.
      Object.defineProperty(this, "paddingX", {
        get: () => INNER_PADDING,
        set: () => {}, // Ignore attempts to change it
        configurable: true,
        enumerable: true,
      });

      // Lock borderColor so the app cannot recolour the frame with theme tokens
      // (e.g. purple thinking levels).
      Object.defineProperty(this, "borderColor", {
        get: () => this.forcedBorderColor,
        set: () => {}, // Ignore attempts to change it
        configurable: true,
        enumerable: true,
      });
    }

    /** Keep the pinned inset if anything calls the setter method. */
    setPaddingX(_padding: number): void {}

    render(width: number): string[] {
      const contentWidth = Math.max(10, width - OUTER_PADDING * 2) - 2;
      return this.boxLines(width, super.render(contentWidth));
    }

    /** Wraps already-rendered editor lines in the rounded frame. */
    private boxLines(width: number, baseLines: string[]): string[] {
      const contentWidth = Math.max(10, width - OUTER_PADDING * 2) - 2;

      if (baseLines.length < 2) return baseLines;

      // Strip pi's default flat horizontal borders to avoid double lines
      const contentLines = baseLines.slice(1, -1);
      const side = this.borderColor("│");
      const outer = " ".repeat(OUTER_PADDING);

      const top = outer + this.borderColor("╭" + "─".repeat(contentWidth) + "╮") + outer;
      const bottom = outer + this.borderColor("╰" + "─".repeat(contentWidth) + "╯") + outer;

      const boxed = contentLines.map((line) => {
        // A chained editor may have drawn its own side borders; only fill gaps
        const hasLeading = line.includes("│");
        const hasTrailing = line.split("│").length - 1 > 1;
        const lead = hasLeading ? "" : side;
        const trail = hasTrailing ? "" : side;
        const used = visibleWidth(line) + visibleWidth(lead) + visibleWidth(trail);
        const padding = " ".repeat(Math.max(0, contentWidth - used));
        return outer + lead + line + padding + trail + outer;
      });

      return [
        truncateToWidth(top, width, ""),
        ...boxed.map((line) => truncateToWidth(line, width, "")),
        truncateToWidth(bottom, width, ""),
      ];
    }
  }

  pi.on("session_start", (event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new BoxedEditor(tui, theme, keybindings));
  });
}
