# pi-quiet-chrome

A restrained terminal UI for the [pi coding agent](https://pi.dev). It replaces pi's default output chrome with folded tool rows, tinted diff bands, code-block backdrops, a boxed input and a powerline status bar.

Every value that affects appearance is a plain constant near the top of its file, so the look can be tuned by editing one line rather than tracing a theme system.

## Extensions

| File | What it does |
|---|---|
| `tool-renderers.ts` | Tool call rows with a status dot; edit and view results as diff previews with line and word bands |
| `code-blocks.ts` | Paints a background band behind fenced code blocks in rendered Markdown |
| `input-box.ts` | Frames pi's editor in a rounded, theme-independent box |
| `status-bar.ts` | Powerline footer: provider and model on the left, git branch centred, context bar and cost on the right |
| `output-chrome.ts` | Status dot on replies, the working line, and breathing room around past prompts |

## Install

Not published yet. Install from a local checkout:

```bash
pi install /path/to/pi-quiet-chrome
```

Or load it for one invocation without adding it to settings:

```bash
pi -e /path/to/pi-quiet-chrome
```

To try one extension only, point pi at the file:

```bash
pi -e /path/to/pi-quiet-chrome/extensions/tool-renderers.ts
```

Once published to npm, it becomes:

```bash
pi install npm:pi-quiet-chrome
```

## Colours

The dark palette in `tool-renderers.ts` is tuned for Tokyo Night Storm:

```ts
const COMMENT_COLOR = "\x1b[38;2;140;150;178m";
```

The diff bands blend the theme's green and red into the terminal background. A blend much above the values shipped will lift the bands past the highlighter's comment grey and make comment lines unreadable on a diff, so treat them as close to the ceiling rather than a starting point.

`PALETTES` carries a light variant, but it has had far less attention than the dark one.

## How it hooks in

Most of these files patch pi at `session_start`: `Markdown.prototype.render`, `UserMessageComponent.prototype.render`, and the editor component. That means they depend on pi internals rather than a stable plugin surface, and a pi release that reshapes those classes can break them. If the UI degrades after an upgrade, check the patch targets before anything else.

`tool-renderers.ts` uses `pi.registerToolRenderer`, which is a supported API and the least brittle of the set.

## Licence

MIT. Portions of `tool-renderers.ts` and `output-chrome.ts` derive from [pi-polish](https://github.com/Pringled/pi-extensions) 0.1.1 by Thomas van Dongen. See [LICENSE](./LICENSE).
