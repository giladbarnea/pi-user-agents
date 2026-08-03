---
description: Provenance and boundary for the overlay's vendored historical tool renderer
last_updated: 2026-07-31
---
# The overlay renders tool history itself

The `/agent` overlay shows a captured child-session transcript. It is not the live transcript.
It has no tool registry, no execution state, and no component lifecycle. `AgentViewer` produces
a `string[]`, and the overlay hard-cuts every line to its own width instead of wrapping it.

That is why this module exists. Pi's `ToolExecutionComponent` resolves current tool definitions
and models live execution, so it cannot render a finished child session whose tools may no
longer be registered.

## Sources

- `../rich-tool-diff/` — `read`, `edit`, `write`, `grep`, `find`, `ls`.
- `../bash-rich-highlight.ts` — `bash`.

Both are **disabled** in committed `agent/settings.json`, while `pi-user-agents` is enabled.
Nothing here imports from either at runtime. The code was copied and adapted, by request.

1973 lines here, from 2857 lines of source.

## The contract this module guarantees

1. Pure. No filesystem access, no `process.stdout`, no timers, no tool registry.
2. Every returned line fits the supplied width and contains no newline.
3. Calls pair with results by `ToolCall.id` only. Order is never a fallback, because parallel
   tool calls make it ambiguous. An unpaired call genuinely has no stored result.
4. Rendering is always expanded, and never mentions an expand key. The overlay has no such key.
5. Every cap counts **rows drawn**, not lines stored. One line of minified output or one long
   command wraps into many rows at overlay width, so a cap on stored lines caps nothing.

## What was deliberately left behind

### Live-execution machinery, which has no meaning for history

Tool registration wrappers, pending and partial rendering paths, the blink timer, the bash
duration timer, and expand-key hints. `attachDiffDetails`, `readTextForDiff` and
`existingSmallTextOrUndefined` read the current filesystem, which is wrong for a transcript
recorded earlier — the file may have changed or been deleted since.

### Settings and glyph lookups, replaced by flat constants

`readVstackConfig()` walks parent directories, stats files, reads JSON and parses it, on every
call. `glyphs(cwd)` sits under several per-line helpers. The overlay re-renders about ten times
a second, so `constants.ts` holds fixed values instead.

Dropping the setting lookups also dropped the ASCII glyph mode. The overlay frame already draws
Unicode box characters unconditionally, so that branch was unreachable — and removing it took
the `cwd` argument out of roughly thirty signatures.

### Terminal-width reads

`renderStructuredDiff()` upstream ignores the width its caller passes and reads
`process.stdout.columns`. Inside a 90%-width overlay that pads rows past the frame, and the
overlay then silently cuts their right side. Here the width is a required argument.

### Path hyperlinks and Nerd Font icons

OSC 8 hyperlinks are zero-width escapes threading through padding and truncation arithmetic
that the overlay performs itself, in a viewport where clicking a path is marginal. The icon
table needs a Nerd Font and renders as tofu without one. Dropping hyperlinks also removed the
last need for a `cwd` argument.

### highlight.js

`bash-rich-highlight.ts` imports highlight.js through an absolute path inside the global Pi
installation, then hand-parses its HTML output into ANSI — about 180 lines. That import breaks
when the installation prefix or the Pi version changes. Pi's own exported
`highlightCode(command, "bash")` returns `string[]` directly.

### Bash git-diff detection

`renderBashDiffOutput` is gated behind `renderBashDiffs`, which defaults to false.

### Images

`OverlayAwareImage` already suppresses images while a floating overlay is active.

## Kept, against expectation

**Split diffs.** They only engage at 132 columns or more, which a wide-terminal overlay reaches.

**Diff backgrounds.** `applyFullLineBg` re-opens the background after every escape that resets
it, so a row carrying syntax highlighting, word-diff highlighting and a row tint stays intact.
`theme.bg` is optional in `RenderTheme`: a theme without it falls back to fixed colours, which
is also what keeps the module renderable under a test theme.

## Behaviour that intentionally differs from the sources

1. Unknown tools show `key=value` arguments. Nested containers become `{2 keys}` or
   `[3 items]`, never serialized JSON — a JSON blob is the exact thing this renderer removes.
2. A bash result whose exit code is `0` renders as success. The sources render `✗ exit 0`.
3. A call with no stored result says `no result` rather than trailing off after the headline.

## Where this is used

`widget.ts` calls it from two places, and both must stay in step:

- `AgentViewer.messageLines()` — the transcript body.
- `describeAssistantPart()` — the one-line activity row under the editor.

`AgentViewer` memoizes rendered content, because rich diff rendering is far too costly for the
widget's 100 ms tick. The memo key covers width, message count, the last message's content
length, agent status, response length and error length. Streamed content only grows, so a
length is a sufficient change signal for the streaming tail.
