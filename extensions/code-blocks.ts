import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Markdown, visibleWidth } from "@earendil-works/pi-tui";

/**
 * Background band behind fenced code blocks.
 *
 * pi has no background token for code (mdCodeBlock is foreground-only), so the
 * band is a raw 24-bit colour. Set CODE_BLOCK_BG to "" to switch it off.
 */

const CODE_BLOCK_BG = "\x1b[48;2;36;39;58m"; // #24273a
const CODE_BLOCK_BG_RESET = "\x1b[49m";
// Spaces between the band edge and the code text
const CODE_BLOCK_PAD_X = 1;
// Spaces between the terminal edge and the band itself
const CODE_BLOCK_MARGIN_X = 2;

/**
 * Paints the band across one rendered line.
 * Highlighting resets its foreground with \x1b[39m, so the background is
 * re-opened after each reset; the fill runs to the band width so it stays solid.
 */
const paintCodeLine = (line: string, width: number): string => {
  // Drop the highlighter's own background so ours shows through
  const body = line
    .replace(/\x1b\[48;[0-9;]*m/g, "")
    .replace(/\x1b\[49m/g, "")
    .replace(/\x1b\[39m/g, `\x1b[39m${CODE_BLOCK_BG}`);
  // The source line already fills `width`, so the trailing pad is rebuilt
  // around the new inset rather than appended to it.
  const trimmed = body.replace(/ +$/, "");
  const inset = " ".repeat(CODE_BLOCK_PAD_X);
  // The band stops short of the terminal edge; the margin is left unpainted
  const margin = " ".repeat(CODE_BLOCK_MARGIN_X);
  const bandWidth = width - CODE_BLOCK_MARGIN_X * 2;
  const fill = " ".repeat(Math.max(0, bandWidth - visibleWidth(trimmed) - CODE_BLOCK_PAD_X));
  return margin + CODE_BLOCK_BG + inset + trimmed + fill + CODE_BLOCK_BG_RESET + margin;
};

export default function (pi: ExtensionAPI) {
  pi.on("session_start", () => {
    if (!CODE_BLOCK_BG) return;
    const proto = Markdown.prototype as unknown as {
      render: (width: number) => string[];
      bgPatched?: boolean;
    };
    if (proto.bgPatched) return;
    proto.bgPatched = true;

    const original = proto.render;
    proto.render = function (this: any, width: number): string[] {
      // Track the block by its fences so blank lines inside it are painted too.
      // Both fences join the band, so the block reads as one card.
      let inBlock = false;
      return original.call(this, width).map((line) => {
        const bare = line.replace(/\x1b\[[0-9;]*m/g, "");
        if (bare.trim().startsWith("```")) {
          inBlock = !inBlock;
          return paintCodeLine(line, width);
        }
        return inBlock ? paintCodeLine(line, width) : line;
      });
    };
  });
}
