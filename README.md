# pi-user-agents

Your main agent doesn't need to know everything.

`pi-user-agents` gives the **user** powerful buttons and levers to run, view and control background agents.

## Simplest use case

_Your main agent is in a tool calling frenzy and isn't stopping anytime soon_

You:

    `/agent` plan the next phase and write to phase-2.md.

Immediately, this launches a background fork of your main agent while that one is still working on phase 1.

When the agent returns, you can view its response.

The fork's session can be viewed, steered and aborted in an overlay.

## Usage examples

### Preserve work before the main agent reaches its context limit

Suppose your main agent is nearing its context-window limit in the middle of important work. Rather than interrupting it to request a handoff document—or waiting and risking that it hits the limit first—dispatch that task to a background agent:

    `/agent` write a handoff document for the work currently in progress.

The fork launches the moment you press Enter, with the current session context, while the main agent continues uninterrupted.

## Commands

- `/agent [pi options] [-m MODELNAME] [-i|--isolate] [-j|--join] <task>` gives the child agent the current session context; pass `-i`/`--isolate` to start it without.
- `/agent-isolated [pi options] [-m MODELNAME] <task>` is an alias for `/agent -i`.

Put options first. The first word that isn't a recognized option ends option parsing; everything from there is your task, kept verbatim (quotes included).

### Passing pi CLI options through

Leading `pi` CLI options are forwarded to the child agent as if you had launched `pi` with them — `/agent --thinking high plan the migration`, `/agent --tools read,grep review the diff`, or `/agent --system-prompt "be terse" summarize this`. The recognized set is a curated snapshot of `pi --help` (see `PARSER_SPEC.md` for the full grammar). `-m` and `--model` are aliases normalized to Pi's `--model`; `-i`/`--isolate` and `-j`/`--join` are consumed by the extension itself.

An option typed *after* the task has begun stays in the task and triggers an advisory reminder to move it up front. An unrecognized `-`-token — a typo, or a third-party flag this extension doesn't track — is simply left in the prose, no error. A few options are rejected outright because they would derail a one-shot background run: `-c`/`--continue`, singular `--theme <path>`, `--models`, `--export`, `--list-models`, `-h`/`--help`, and `-v`/`--version`. This policy applies to both commands. `--no-themes` remains supported and is forwarded to the child.

To keep an option-looking word in the task, quote it (`summarize "-m stays literal"`) or backslash-escape it (`explain \--thinking`) — quotes stay in the prompt, the leading backslash is removed. An option's value may be quoted to include spaces: `--system-prompt "be terse and precise"`.

### Semantic command coloring

While you type, the editor paints `/agent` and `/agent-isolated` lines from the same
semantic scan that drives submission parsing (see `PARSER_SPEC.md` §11): the command in the
theme's `accent`, recognized leading options in `syntaxKeyword`, and valid values (quotes
included) in `syntaxString`. Invalid thinking levels, unresolved model IDs or aliases, and
unknown provider or tool names use `error`, as do explicitly blocked Pi options such as
`-c`/`--continue` and options typed after the task prose has begun — along with their values.
Validation comes from Pi's argument parser, model resolver, and live catalogs rather than a
second editor grammar.
Prose, unknown dash-words, quoted spans, and escaped words stay plain. All colors come from
the active Pi theme, so custom themes and hot reload apply automatically.

### Eager argument completion

Type `/agent -` or `/agent-isolated -` and the option menu opens immediately—no Tab is required. Short and long aliases appear separately, while using either one hides the whole semantic option from later menus. `/agent-isolated` therefore never recommends `-i` or `--isolate`. Once you begin the task prose, quoted text, or an escaped dash, the option menu stays off.

The finite value menus are thinking levels, live providers, live models, and the session's live tool catalog. Models from the configured `enabledModels` scope lead the unfiltered model menu; once you type a query, Pi's fuzzy relevance controls the order and scope only breaks equal-score ties. `--provider` narrows the model menu for either `-m` or `--model`. A completed boolean, thinking level, provider, or model leaves exactly one trailing space.

`--tools`/`-t` and `--exclude-tools`/`-xt` complete one comma-delimited segment at a time. Accepting `grep` produces `--tools grep│`—the menu closes without inserting a space or comma. Type `,` to open the next segment immediately; already selected tools are omitted. Type a normal space when the tool list is finished.

Free-form values are guarded instead of guessed. Selecting `--system-prompt` produces `/agent --system-prompt "│" `, with the cursor between the quotes and the trailing separator already preserved.

`--extension`/`-e`, `--skill`, and `--prompt-template` are path-valued. Accepting one from the option menu eagerly opens filesystem completion inside its guarded quotes, and manually typing an exact path option plus its value-boundary space now opens the same menu without Tab. Directories continue traversal inside the quotes; accepting a file finishes the quoted path and moves the cursor after the outer space. Completion in the middle changes only the active fragment and preserves everything after it.

Installed skills and prompt templates also appear as named shortcuts from public `pi.getCommands()` entries. Selecting one inserts its public `sourceInfo.path`, while arbitrary filesystem entries remain available in the same menu. Extensions stay filesystem-only because command-backed extension discovery is incomplete. No theme path menu is offered: singular `--theme <path>` remains blocked, while `--no-themes` remains supported.

By default the entire run is invisible to the main agent: the invocation, the child's tool calling, and the result do not enter its context. Each completed turn's result renders in the transcript as a TUI-only session entry (persisted, survives reloads) — for your eyes only — and the agent's session **stays alive**: its widget entry turns into a green-checked turn-complete row, and you can steer it into another turn from its overlay. The agent remains available until you explicitly join or dispose it. With `-j`/`--join`, the run is still invisible while in flight, but on completion the result — carrying your verbatim command invocation in a `<user_invocation>` tag — is delivered to the main agent ASAP, like a steering message: steered into its current turn if one is streaming, or triggering an immediate response if it is idle. A `-j` run's session ends with that delivery.

An agent launched without `-j` offers `j join` in its overlay once a turn has completed. Pressing it sends the latest invocation-and-result message to the main agent with the same trigger behavior as `-j`, and retires the agent's live session — joining is one of the two terminal actions, alongside dispose. The context-bearing message is hidden in the transcript because the original TUI-only result card is already visible. Joining is unavailable while the child is in flight, for runs launched with `-j`, and after a run has already been joined.

The widget below the editor shows in-flight, turn-complete, and finished agents. Use `←` or `↓` to select it, `Enter` to open an agent overlay, and `x` to stop a running agent, dispose a turn-complete one, or dismiss a finished one.

### Context window meter

Each agent row places a one-cell context meter between the command and its prompt:

```text
✓ User agents
  ↑↓ select · Enter view · x dispose · Esc back
└─ ⏺ ✓ /agent ▇ i am testing the widget now - read a ton...
     ⎿  Loaded several large Pi source and documentation...
```

The meter shows how much of that child agent's selected model context window is in use. It has eight 12.5% bins—`▁▂▃▄▅▆▇█`—and shifts from white toward red as the context fills. Completed rows retain their final reading. The extension reads Pi's resolved model and live session context usage, so model-specific limits and configured `contextWindow` overrides are respected; when Pi cannot provide a usage percentage, the meter is omitted rather than guessed.

The overlay shows the agent's full rolling conversation — user prompts, assistant turns, tool calls, and tool results — and follows the tail while the agent streams. Scroll up to pause following; `End` resumes it. Once a turn of a run launched without `-j` has completed, press `j` to join its original invocation and latest response into the main context.

## Steering an agent

Press `Enter` in an agent's overlay to open the **Steer** input, and submit a message with `Enter`; `Esc` cancels the composer. While the agent is mid-turn, Pi queues the message after its current tool work, before its next model call. When the agent has completed its turn (green check), the same input starts **another turn** on the still-alive session — the entry flips back to a spinner, and on completion posts a fresh result card and returns to the steerable turn-complete state. Repeat as many times as needed.

Turn completion no longer disposes the child session. Only three things do: pressing `x` on the agent, joining it with `j`, or ending the Pi session. A `-j` run is the exception — it delivers its result to the main agent on completion and ends there. After an error or a `-j` completion, the overlay remains available to read the captured transcript or copy the result, but it is no longer interactive.

## Result delivery — Pi SDK mental model

How a finished run reaches (or hides from) the main agent rests on two Pi SDK channels with very different context semantics:

- **`pi.sendMessage(message, { deliverAs, triggerTurn })`** — custom messages ALWAYS reach the main agent's LLM context eventually. The options form a first-match-wins chain (see `sendCustomMessage` in pi's `dist/core/agent-session.js`):
  1. `deliverAs: "nextTurn"` → buffered in memory, spliced in alongside the user's next prompt; `triggerTurn` ignored; not persisted — lost if the session ends first. Still reaches the agent eventually.
  2. Agent streaming → `"followUp"` queues for after the run finishes; `"steer"` (default) injects after the current tool batch, before the next LLM call. `triggerTurn` ignored. Queues drain before `agent_end` — messages are never dropped.
  3. Agent idle + `triggerTurn: true` → appended and an LLM turn starts immediately.
  4. Agent idle otherwise → silently appended to context; the agent sees it on whatever turn comes next.

  In short: `deliverAs` only matters while streaming; `triggerTurn` only matters while idle.

- **`pi.appendEntry(customType, data)` + `pi.registerEntryRenderer`** — the only channel that renders in the transcript while staying out of LLM context *forever*. Entries are persisted in the session file and re-rendered on reload. The entry's `data` is optional in the type — renderers must guard it.

This extension maps the two extremes onto the `-j` flag: the default posts the result card via `appendEntry` (main agent structurally oblivious), and `-j` posts a visible custom message with `{ triggerTurn: true }` (steered mid-turn or answered immediately). Both channels share one card renderer in `transcript.ts`.

Immediate `-j` delivery and late `j join` delivery also share one canonical message builder. Its required `display` option is `true` for `-j` and `false` for a join, preventing a second copy of the already-visible result card. The message content, metadata, and `{ triggerTurn: true }` delivery are otherwise identical.

## Runtime sharing

Child agent sessions share the parent's `ModelRuntime` instance. This is critical because extension-registered providers (like `claude-bridge`) use a global `Symbol.for` dedup guard — they register once per process and skip subsequent loads. A child session with its own fresh runtime would never receive the provider, leaving it without auth for bridge-backed models.

The shared runtime is extracted from the parent's `ModelRegistry` facade (`ctx.modelRegistry`) which wraps a `ModelRuntime` as a plain `.runtime` property.

## Model name & alias resolution

User-defined model aliases (`name` in `models.json` `modelOverrides`) take precedence: `-m opus` resolves to `claude-bridge/claude-opus-4-6` directly, without ambiguity. The extension checks for an exact name match before falling through to the SDK's `resolveCliModel`, which only checks `model.id` (never `model.name`) and otherwise falls back to substring matching — where "opus" collides with dozens of built-in models across the catalog.

> **Note (known issue):** `enabledModels` (i.e., “Scoped models”) currently have no special role in how the extension resolves models. They should be promoted to the same precedence level as user-defined model names in a future fix.

Exact names should be unique: duplicate aliases silently select the first model, and an exact alias match currently ignores `--provider`, even if it names another provider.

---

Heavily inspired by [tintinweb/pi-subagents](https://github.com/tintinweb/pi-subagents).
