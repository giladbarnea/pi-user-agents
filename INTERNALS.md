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

This extension maps the two extremes onto the `-s` flag: the default posts the result card via `appendEntry` (main agent structurally oblivious), and `-s` posts a visible custom message with `{ triggerTurn: true }` (steered mid-turn or answered immediately). Both channels share one card renderer in `transcript.ts`.

Immediate `-s` delivery and late `s` squash delivery share one canonical message builder. Its `display` option prevents a second visible result card. Both paths use the same selected conversation and `{ triggerTurn: true }` delivery. For a run launched without `-s`, the context message stays hidden at squash time because the TUI-only result card is already visible.

## Squashed message format

The squashed text starts with this sentence:

> The user has dispatched a background sub-agent with a task. The sub-agent is done. The following is the back and forth between them:

A plain `<user_agent>` tag follows it. The tag contains only the model and inherited-context attributes. Its body contains numbered `<user_message>` and `<assistant_response>` tags, indented by two spaces. The first user message contains the original task without the extension's internal process prefix.

One selection rule builds the body. It keeps every user message. Before each next user message, it keeps only the latest assistant response. It applies the same rule after the final user message. Tool calls, thinking, tool results, and other message roles stay out.

## Rebase

`r` fast-forwards the raw child conversation onto the dispatching session. Three Pi facts shape the mechanism:

1. The main agent's next LLM call reads the in-memory `agent.state.messages`, not the session file, and the TUI transcript renders from `AgentSession` events, not from the `SessionManager`. Appending entries alone reaches neither.
2. Extensions have no path to the main `AgentSession`, so the state cannot be pushed in place.
3. On `ctx.switchSession()` the host rebuilds both from the file — `agent.state.messages` from `buildSessionContext()` and the transcript from `buildContextEntries()` — while tearing the extension runtime down (`session_shutdown`, then a fresh extension instance).

Delivery therefore appends the processed messages through the session manager (`ctx.sessionManager` is typed `ReadonlySessionManager`, but the runtime object is the writable `SessionManager` — one cast), drops a persisted `pi-user-agents-rebased` breadcrumb entry naming the child session, and calls `ctx.switchSession(<current session file>)`. Not `ctx.reload()` — that one reloads extensions and resources only and never re-reads the session file.

Message processing (`selectRebaseMessages`) keeps the child's history verbatim, with two exceptions: the first user message becomes the plain task (dropping the internal background-process prefix), and this extension's own custom messages (`pi-user-agents`) are dropped — they are the one trace of the user-agents machinery. Everything else the child saw passes through, other extensions' custom messages included.

A child compaction passes through deliberately and lands as a real `compaction` entry mid-file. `buildContextEntries` treats the latest compaction on the path as the context boundary, so after the switch main's LLM context is exactly the child's live context — summary, kept tail, then everything after — while the transcript keeps the full history. Dropping it would instead graft an over-window context onto main and force a fresh, lossy auto-compaction.

Two mechanics make that exact. First, a live compaction emits no message event — only `compaction_end` — so the child subscription captures it there as a synthetic `compactionSummary` message, or the append-only conversation would never contain it. Second, the kept-tail boundary (`firstKeptEntryId`) is a child-session entry id that means nothing in the main session's file; but at `compaction_end` the child's live context is exactly `[summary, kept tail]`, so the capture records `keptTailCount`, and the rebase replay counts back that many context messages to pass the main-session id of the message that starts the tail. The tail may reach past the replayed messages into main's pre-existing context — a child that inherits a nearly full context compacts early — so the delivery prepends main's own per-message entry ids to the count.

The fast-forward precondition is fingerprint equality: at dispatch the agent stores `JSON.stringify` of the inherited context messages (`[]` for `-i`), and `r` is offered only while the main session's current `buildSessionContext().messages` fingerprint still matches. The live fingerprint is cached per session manager and recomputed only when the branch leaf moves, so TUI-only entries (result cards, detach lines) move the leaf, trigger one recompute, and correctly do not block the rebase. One rule covers isolated agents too: their base is empty, so they rebase only onto a still-empty session.

Because the session switch tears the extension down, live widget rows cannot survive it: `r` is withheld while any agent is mid-turn, and the remaining parked and completed agents are detached first through the ordinary detach paths, so every one of them leaves its `Detached session …` breadcrumb before the switch. The switch re-opens the same file, so the session id does not change.

## Child session persistence

Every dispatched agent gets a persisted `SessionManager.create(cwd, undefined, { parentSession })` rather than an in-memory one, so its conversation is an ordinary Pi session file from birth. `parentSession` is a *path*, and it records the main session that dispatched the agent — the same field `/fork` uses, surfaced by `SessionManager.list()` as `parentSessionPath`. There is no API to promote an in-memory session to disk later: `SessionManager` fixes `persist` at construction, and both `_persist()` and `_rewriteFile()` return early when it is false, so `setSessionFile()` on an in-memory manager sets a path and writes nothing.

Two ordering constraints follow from `createAgentSession`:

1. **Build the session while its manager is still empty.** Pi writes the `model_change` and `thinking_level_change` entries only on the empty-session path. Seed messages first and those entries never appear, so a resumed child falls back to `findInitialModel` instead of the model it was dispatched with.
2. **Route the inherited snapshot through the session manager.** Persistence runs off message events, so the old `session.agent.state.messages = inherited` assignment never reached the file. `persistMessages` appends it entry by entry, then the agent state is set to the same list.

That snapshot is already compaction-resolved, so at most one `compactionSummary` leads it. Each role takes its own append method — `appendCompaction`, `branchWithSummary`, `appendCustomMessageEntry`, `appendMessage` — because pi's own compaction and branch bookkeeping locates boundaries by entry type, and a summary written as a plain message entry would be invisible to it. `appendCompaction` wants a `firstKeptEntryId` the replay cannot know, but `buildContextEntries` only consults it for entries *before* the compaction entry; a leading compaction has none, so the value is never read.

The file itself appears on the child's first assistant message (`_persist` defers until then). An agent dispatched with `-i` that never answers therefore leaves nothing behind, while an agent that inherited context has a file immediately.

## Detaching

`d` `d` ends the live child session and drops its widget row. The session file is untouched, and the transcript gets a `pi-user-agents-detached` custom entry naming the session id so it can be resumed later. Both detach paths funnel through `closeRunning` and `removeCompleted`, which is where the announcement is made; squashing and session shutdown deliberately do not announce.

## Attaching

`/agent-attach <session-id>` reverses a detach. The id (or a unique prefix) resolves against file names in pi's default session directory for the cwd — the directory every dispatch creates children in — because `SessionManager.list()` would read every session file whole, gigabytes in a mature project. The authority for "is a child of this session" is the child file's header: its `parentSession` path must equal the main session's file. That is the same field `/fork` writes, so a fork of the main session attaches too.

Reattachment is pi's own resume path: `SessionManager.open` plus `createAgentSessionFromServices` on a non-empty manager restores the messages, model, and thinking level from the child's file (`createAgentSession` takes the has-existing-session branch). The dispatch preamble — built at the dispatch call site, sent verbatim by `runChildTurns` — doubles as the boundary marker: `splitAtDispatchBoundary` finds the first user message carrying it and recovers the plain task, the child's own conversation for the overlay, and the inherited base whose fingerprint re-arms the rebase fast-forward. Without a recognizable boundary (a fork child, or a child whose compaction summarized it away) the whole context attaches and the base is a sentinel that never matches, so `r` stays withheld.

The attached agent parks idle first (`runAttachedTurns` waits for an instruction before running the shared turn loop), and its latest persisted response seeds `pendingSquashMessage`, so steering, `s`, and `r` work immediately without a new turn. Both success states end with a "View agent?" confirmation that opens the overlay; a session that already has a widget row — live or completed — short-circuits to that confirmation and nothing else, which is what makes the command idempotent.

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
