# Internals

Design notes for contributors. User-facing behavior is documented in [README.md](README.md); the command grammar is specified in [PARSER_SPEC.md](PARSER_SPEC.md).

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

Immediate `-j` delivery and late `j join` delivery share one canonical message builder. Its `display` option prevents a second visible result card. Both paths use the same selected conversation and `{ triggerTurn: true }` delivery. For a run launched without `-j`, the context message stays hidden at join time because the TUI-only result card is already visible.

## Joined message format

The joined text starts with this sentence:

> The user has dispatched a background sub-agent with a task. The sub-agent is done. The following is the back and forth between them:

A plain `<user_agent>` tag follows it. The tag contains only the model and inherited-context attributes. Its body contains numbered `<user_message>` and `<assistant_response>` tags, indented by two spaces. The first user message contains the original task without the extension's internal process prefix.

One selection rule builds the body. It keeps every user message. Before each next user message, it keeps only the latest assistant response. It applies the same rule after the final user message. Tool calls, thinking, tool results, and other message roles stay out.

## Runtime sharing

Child agent sessions share the parent's `ModelRuntime` instance. This is critical because extension-registered providers (like `claude-bridge`) use a global `Symbol.for` dedup guard — they register once per process and skip subsequent loads. A child session with its own fresh runtime would never receive the provider, leaving it without auth for bridge-backed models.

The shared runtime is extracted from the parent's `ModelRegistry` facade (`ctx.modelRegistry`) which wraps a `ModelRuntime` as a plain `.runtime` property.

## Model name & alias resolution

User-defined model aliases (`name` in `models.json` `modelOverrides`) take precedence: `-m opus` resolves to `claude-bridge/claude-opus-4-6` directly, without ambiguity. Other model values must exactly match a live model ID or canonical `provider/id` reference before the extension calls the SDK's `resolveCliModel`. Partial and custom model IDs are rejected.

> **Note (known issue):** `enabledModels` (i.e., “Scoped models”) currently have no special role in how the extension resolves models. They should be promoted to the same precedence level as user-defined model names in a future fix.

Exact names should be unique: duplicate aliases silently select the first model, and an exact alias match currently ignores `--provider`, even if it names another provider.

## Editor: coloring and completion details

### Semantic command coloring

While you type, the editor paints `/agent` lines from the same semantic scan that drives submission parsing (see `PARSER_SPEC.md` §11): the command in the theme's `accent`, recognized leading options in `syntaxType`, and valid values (quotes included) in `syntaxString`. Invalid thinking levels, unresolved model IDs or aliases, and unknown provider or tool names use `error`, including blocked Pi options such as `-c`/`--continue` and `-p`/`--print`, plus options typed after the task prose has begun — along with their values. Validation comes from Pi's argument parser, model resolver, and live catalogs rather than a second editor grammar. Prose, unknown dash-words, quoted spans, and escaped words stay plain. All colors come from the active Pi theme, so custom themes and hot reload apply automatically.

### Eager argument completion

Type `/agent -` and the option menu opens immediately — no Tab is required. Short and long aliases appear separately, while using either one hides the whole semantic option from later menus. Once you begin the task prose, quoted text, or an escaped dash, the option menu stays off.

The finite value menus are thinking levels, live providers, live models, and the session's live tool catalog. Models from the configured `enabledModels` scope lead the unfiltered model menu; once you type a query, Pi's fuzzy relevance controls the order and scope only breaks equal-score ties. `--provider` narrows the model menu for either `-m` or `--model`. A completed boolean, thinking level, provider, or model leaves exactly one trailing space.

`--tools`/`-t` and `--exclude-tools`/`-xt` complete one comma-delimited segment at a time. Accepting `grep` produces `--tools grep│` — the menu closes without inserting a space or comma. Type `,` to open the next segment immediately; already selected tools are omitted. Type a normal space when the tool list is finished.

Free-form values are guarded instead of guessed. Selecting `--system-prompt` produces `/agent --system-prompt "│" `, with the cursor between the quotes and the trailing separator already preserved.

`--extension`/`-e`, `--skill`, and `--prompt-template` are path-valued. Accepting one from the option menu eagerly opens filesystem completion inside its guarded quotes, and manually typing an exact path option plus its value-boundary space opens the same menu without Tab. Directories continue traversal inside the quotes; accepting a file finishes the quoted path and moves the cursor after the outer space. Completion in the middle changes only the active fragment and preserves everything after it.

Installed skills and prompt templates also appear as named shortcuts from public `pi.getCommands()` entries. Selecting one inserts its public `sourceInfo.path`, while arbitrary filesystem entries remain available in the same menu. Extensions stay filesystem-only because command-backed extension discovery is incomplete. No theme path menu is offered: singular `--theme <path>` remains blocked, while `--no-themes` remains supported and is forwarded to the child.
