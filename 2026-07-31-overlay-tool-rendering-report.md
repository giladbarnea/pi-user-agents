# Overlay tool rendering research report

This report prepares an implementation team to improve historical tool rendering in the `pi-user-agents` overlay.

It consolidates the joint findings from `user-agents-researcher` and `tool-style-researcher`. It includes their post-report correction. Research only. No implementation files were changed.

The preceding resumption document is:

`2026-07-31-overlay-tool-rendering-handoff.md`

The target screenshot is:

`/var/folders/28/9x0yw2vs4bzd8s3p7pyfs1kc0000gn/T/pi-clipboard-80f8593b-f25b-42c1-8027-ad4a614a14b6.png`

## The overlay already has the right insertion point

`runner.ts:85` builds child sessions with `createAgentSessionServices({ cwd, agentDir, settingsManager, ... })`. `runner.ts:420` then calls `session.bindExtensions({ mode: "print" })`. Child sessions can therefore load enabled global extensions.

The overlay later renders captured history independently. `widget.ts:898` gets messages through `transcriptMessages()`:

- A running agent uses `agent.session.agent.state.messages.slice(agent.inheritedMessageCount)`.
- A finished agent uses `agent.messages`.

Rendering follows this path:

`AgentViewer.render(width)` → `contentLines(innerWidth)` → `transcriptLines(width)` → `messageLines(message, width)`

The overlay is a line-array producer, not a mounted component host. `messageLines()` returns `string[]`. It has no component registry or lifecycle, and it does not call `invalidate()`.

That structure still supports the copied renderers. The assistant-text branch already constructs Pi's `Markdown` component, calls `.render(width)`, and appends the returned lines. Any local object that implements `render(width): string[]` can use the same boundary.

The real overlay width reaches `messageLines()`. The overlay opens at 90% terminal width and 70% terminal height. `transcriptLines()` later calls `truncateToWidth(line, width)` on every line. This hard-cuts wide output rather than wrapping it. Every copied renderer must therefore use the supplied overlay width.

Do not instantiate Pi's live `ToolExecutionComponent` in the overlay. It resolves current tool definitions and models live execution state. The overlay displays historical child-session data whose current definitions may differ or no longer exist.

## Two sites create the raw appearance

`widget.ts:867` renders calls as:

```ts
`${part.name} ${JSON.stringify(part.arguments)}`
```

`widget.ts:879` renders results as a bracketed tool name followed by wrapped raw output:

```ts
`[${message.toolName}]`
```

`capTranscript()` then cuts output at `TRANSCRIPT_OUTPUT_CAP = 500` characters. This is a character cap, not a line-aware preview.

A second site uses the same raw call presentation. `describeAssistantPart()` in `widget.ts:522` builds the one-line activity preview below the editor. The implementation must fix both sites.

## The source presentation covers seven known tools

`rich-tool-diff` deliberately covers six tools:

1. `read`
2. `edit`
3. `write`
4. `grep`
5. `find`
6. `ls`

`bash-rich-highlight/index.ts` covers the seventh tool, `bash`.

Neither source handles MCP tools, arbitrary custom tools, `apply_patch`, or `tool_batch`. `rich-tool-diff/FORK.md` deliberately excludes its upstream generic renderer. There is no universal renderer to copy.

The recommended first-class scope is therefore these seven tools. Every other tool uses a compact generic fallback.

## The implementation must vendor the rendering code locally

Create one self-contained historical rendering module inside `pi-user-agents`. Do not import from `rich-tool-diff/` or `bash-rich-highlight/index.ts` at runtime.

This boundary follows the user's explicit copy-and-adapt preference. It also avoids coupling an enabled extension to two disabled extensions.

Both source extensions are disabled in committed `agent/settings.json`:

- `-extensions/rich-tool-diff/index.ts`
- `-extensions/bash-rich-highlight/index.ts`

`pi-user-agents` remains enabled. Pi's package manager maps the `-` prefix to `forceExcludes` and `enabled = false` in `dist/core/package-manager.js:519,527`.

`bash-rich-highlight/index.ts` already imports five modules from `rich-tool-diff`: `ansi`, `diff`, `glyphs`, `text`, and `theme`. Copying Bash presentation alone is therefore not a smaller dependency path.

Copy and adapt:

- `ansi.ts`
- `glyphs.ts`
- `theme.ts`
- `text.ts`
- `diff.ts`
- the renderer bodies from `tools.ts`
- the relevant renderer bodies from `bash-rich-highlight/index.ts`

Do not copy:

1. `images.ts`. `OverlayAwareImage` already suppresses images while a floating overlay is active.
2. `settings.ts`. Replace it with flat overlay-specific constants.
3. Tool registration wrappers. `pi-user-agents` must not register replacement tools.
4. `attachDiffDetails`, `readTextForDiff`, and `existingSmallTextOrUndefined`. They support execute wrappers or read the current filesystem, which is wrong for history.
5. Pending and partial rendering paths. Historical rendering uses `isPartial: false`.
6. The blink timer and live-duration timer.
7. Expand key hints. The overlay does not provide the referenced binding.

The team estimated that the vendored result would contain approximately 1,500 to 1,800 lines, down from about 2,850 source lines.

## Pair historical calls and results by their stable identity

The persisted SDK types provide an exact pairing key:

```ts
interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

interface ToolResultMessage<TDetails> {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: TDetails;
  isError: boolean;
  timestamp: number;
}
```

Build one `Map<toolCallId, ToolResultMessage>` pre-pass. Render each call with the result whose `toolCallId` equals the call's `id`.

Do not add an order-based fallback. Parallel tool calls make ordering ambiguous. An unmatched call means that the call remained in flight or was aborted.

A stored `ToolResultMessage` already matches the copied renderers' result input. It contains `content`, `details`, and `isError`. Synthesize only the historical render context:

- arguments from the paired `ToolCall`
- the child session working directory
- `argsComplete: true`
- the result error state
- `isPartial: false`
- `expanded: true`

## Use built-in persisted details instead of reconstructing history

The disabled source extensions do not add `vstackDiff` details. The built-in Pi tools still persist useful structured details:

| Tool | Persisted details |
|---|---|
| `read` | `truncation?` |
| `grep` | `truncation?`, `matchLimitReached?` |
| `find` | `truncation?`, `resultLimitReached?` |
| `ls` | `truncation?`, `entryLimitReached?` |
| `bash` | `truncation?`, `fullOutputPath?` |
| `edit` | `diff`, `patch`, `firstChangedLine?` |
| `write` | no details |

Use `edit` result `details.patch` as the primary source. It shows the edit that Pi actually applied, with real line numbers. Arguments show only the intended edit and can diverge after a partial failure.

`diff.ts` already provides the needed path:

`details.patch` → `parseUnifiedDiffOutput()` → `renderStructuredDiff()`

Use the arguments-derived edit diff only when `details.patch` is absent.

`write` alone needs an arguments-derived diff:

```ts
buildStructuredDiff("", args.content)
```

Keep existing truncation-summary handling. Built-in result details make its structured branches work. Regex sniffing remains a last resort.

## Bash uses the normal call-and-result path

The overlay has a separate `bashExecution` message role, but Pi documents that role as the interactive `!` command. A headless child agent does not use that command.

`bash-rich-highlight/index.ts` registers an ordinary tool named `bash`. Agent Bash activity therefore appears as a normal `ToolCall` and `ToolResultMessage` pair.

Use the same first-class historical path for all seven tools. Leave the overlay's existing `bashExecution` branch alone.

For the one-line activity preview, do not use the full `bashCallText()` output. That helper intentionally preserves multiline commands. Take its first line explicitly.

## Render expanded output with small overlay-specific caps

Use `expanded: true`, not collapsed mode.

The overlay is a dedicated inspection surface. More importantly, collapsed source renderers emit instructions for an expand key that the overlay does not have:

- `collapsedDiffHint` says `ctrl+o to expand` when collapsed.
- `BashResultRenderComponent` shows its expand hint only when not expanded.

Expanded mode removes these false instructions without adding branches to copied code.

Expanded source defaults are much too large. Diff output can reach 4,000 rows, and Bash output can use `Number.MAX_SAFE_INTEGER`. Replace these values with small explicit overlay caps in the constants object.

Also set smaller `readPreviewLines` and `searchPreviewLines` values than the upstream 80-line defaults. Scrolling still gives the user access to the capped historical view.

Remove `capTranscript()`'s 500-character cap from the rich-rendering path. It conflicts with the new line-aware preview limits.

## Thread the real width through diff rendering

`renderStructuredDiff()` currently ignores the width passed by its caller. It uses module-global `terminalWidth()`, which reads `process.stdout.columns` in `ansi.ts:52-56`.

Inside a 90%-width overlay, this pads rows to the full terminal width. The overlay then silently cuts their right side.

Change the copied renderer to use the supplied overlay width throughout. Do not call global terminal-width helpers for historical overlay layout.

## Add a generic fallback for every unsupported tool

The fallback must show:

- the tool name
- readable arguments
- execution status
- available result text

It must not add tool-specific branches without a known presentation contract. This fallback covers MCP tools, custom tools, and future tools.

Replace the existing bracketed result label with the renderer headline. Keeping both duplicates the tool name.

## Performance work is part of this feature

The overlay currently recomputes the full transcript about ten times per second:

- `UserAgentWidget.ensureTimer()` starts a 100 ms interval.
- `update()` calls `requestRender()`.
- Nothing pauses that timer while the viewer is open.
- `AgentViewer.render(width)` recomputes the transcript without memoization.
- The scroll handler calls `contentLines()` again to compute `maxScroll`.

The source settings and glyph helpers also perform uncached filesystem work. `readVstackConfig()` walks parent directories, checks files, reads a file, and parses JSON. `glyphs(cwd)` sits under several per-line helpers.

The current raw renderer hides this cost because it mostly calls `JSON.stringify()`. Rich diff rendering will make it visible.

The implementation must:

1. Replace source settings and glyph lookups with constants or cached values.
2. Memoize rendered transcript output using the agent, transcript state, and width.
3. Invalidate that memo when streamed content changes, not only when the message count changes.
4. Remove the duplicate `contentLines()` computation from scroll handling.
5. Keep strict overlay-specific result caps.

## SDK and dependency constraints

The Pi TUI component contract requires only:

```ts
render(width: number): string[];
invalidate(): void;
```

The overlay constructs fresh renderers and does not reuse `context.lastComponent`. Per-instance width caches are therefore harmless but provide little value.

Confirmed Pi coding-agent exports include:

- `highlightCode`
- `getLanguageFromPath`
- `truncateToVisualLines`
- `keyHint`
- the built-in `create*Tool` factories

The image exports are unnecessary because the historical overlay must not render images.

Confirmed Pi TUI exports include:

- `visibleWidth`
- `truncateToWidth`
- `wrapTextWithAnsi`
- `getCapabilities`
- `hyperlink`

`normalizeTerminalOutput` does not exist in Pi TUI. `text.ts` guards for it and falls back to replacing tabs. Do not build the copied renderer around that missing function.

`bash-rich-highlight/index.ts:4` imports highlight.js through an absolute path inside the global Pi installation. Do not reproduce that dependency. It breaks when the installation prefix or Pi version changes.

## Implementation-ready decisions

1. Vendor a self-contained historical renderer into `pi-user-agents`.
2. Support `read`, `edit`, `write`, `grep`, `find`, `ls`, and `bash` first-class.
3. Pair calls and results only by `ToolCall.id` and `toolCallId`.
4. Use built-in persisted details, especially `edit.details.patch`.
5. Use a compact generic fallback for every other tool.
6. Run renderers with `expanded: true` and small explicit caps.
7. Thread the real overlay width through every renderer.
8. Fix both `messageLines()` and `describeAssistantPart()`.
9. Use only the first Bash command line in the activity preview.
10. Remove live-state, image, settings, registration, and expand-hint code.
11. Memoize historical rendering and remove duplicate transcript recomputation.
12. Keep `bashExecution` unchanged because agent Bash uses the normal tool path.
13. Drop historical Bash duration. Parallel calls make timestamp-derived duration misleading.

## Adjacent issues remain out of scope

The research found two unrelated transcript omissions:

- `messageLines()` drops assistant `thinking` parts, although the activity line uses them.
- `messageLines()` has no branch for `branchSummary` or `compactionSummary`.

These do not block tool rendering.

## Provenance

`tool-style-researcher` owned the source side: `rich-tool-diff`, `bash-rich-highlight`, SDK export checks, disabled-extension state, the width bug, live-state exclusions, and the unified-diff parser.

`user-agents-researcher` owned the overlay side: the historical data and rendering path, stable identity pairing, built-in details, the Bash message correction, both raw-rendering sites, and performance constraints.

The agents cross-checked findings that changed the recommendation. Their direct messages were delayed by approximately fourteen minutes, so they also exchanged a self-contained file at `/tmp/overlay-sink-findings.md` before converging. The delay did not change the final technical conclusions.
