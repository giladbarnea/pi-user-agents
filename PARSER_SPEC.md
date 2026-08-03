# `/agent` command-line parser — specification

This is the authoritative spec for how the shared command-line engine interprets
submitted `/agent` / `/agent-isolated` input and pre-submit editor input. Runtime parsing
and eager autocomplete both derive option names, arity, aliases, roles, and value domains
from the declaration in `command-line.ts`.

## 1. What the parser produces

```ts
type ParsedAgentCommand = {
  isolate: boolean;          // -i / --isolate
  context: boolean;          // -j / --join
  forwardedArgs: string[];   // recognized pi option tokens (+values) in input order, e.g. ["--thinking","high"]
  task: string;              // the prose prompt (backslash escapes applied, quotes kept). Never empty.
  warnings: string[];        // advisory messages (see §5). May be empty.
};
```

`forwardedArgs` contains **only** known, non-blocked pi options — never the extension's own
options, never unknown/third-party tokens. It is later mapped to child-session inputs by
`resolveForwardedOptions` (unchanged in spirit, but the unknown-flag path is removed).

## 2. The state machine (one-way: args → prose)

Read whitespace-delimited tokens from the front. Start in **args mode**.

- In args mode, classify each token (§4). A recognized option is consumed (with its value if it
  takes one) and we stay in args mode.
- The **first** token that is not a recognized option flips us to **prose mode**, permanently.
  There is no path back to args mode.
- **Prose** is the remainder of the original input starting at the flip token, kept verbatim
  except for backslash-escape processing (§6). Whitespace and quotes are preserved exactly.

If options are consumed and nothing is left, that is a usage error (a task is required).
When the very first token is prose, the entire original input is the task, including any
leading whitespace (unchanged from today).

## 3. Recognized options

### 3a. Extension-owned and normalized options
| Token(s) | Arity | Effect |
|---|---|---|
| `-m`, `--model` | value | Added to `forwardedArgs` as canonical `--model <value>` |
| `-i`, `--isolate` | boolean | Consumed here; `isolate = true` |
| `-j`, `--join` | boolean | Consumed here; `context = true` |

`-m` and `--model` are one semantic option. Both resolve once through Pi's
`resolveCliModel()` path, and a preceding `--provider` scopes either spelling. `-j` is the
extension's join option. A model option with no value and no remaining task ends in the normal
**usage error**.

### 3b. Known pi options — declared statically; added to `forwardedArgs`
**Value-taking** (consume the next token as the value):
`--provider`, `--api-key`, `--system-prompt`, `--append-system-prompt`, `--mode`,
`--name`/`-n`, `--session`, `--session-id`, `--fork`, `--session-dir`, `--tools`/`-t`,
`--exclude-tools`/`-xt`, `--thinking`, `--extension`/`-e`, `--skill`, `--prompt-template`.

**Boolean** (consume no value):
`--resume`/`-r`, `--no-session`, `--no-tools`/`-nt`, `--no-builtin-tools`/`-nbt`,
`--no-extensions`/`-ne`, `--no-skills`/`-ns`, `--no-prompt-templates`/`-np`, `--no-themes`,
`--no-context-files`/`-nc`, `--verbose`, `--approve`/`-a`, `--no-approve`/`-na`, `--offline`,
`--print`/`-p`.

Notes:
- The shared declaration is a snapshot of `pi --help`; it is maintained by hand. There is no
  runtime dependency on pi's parser for recognition or arity.
- **Reading a value** (applies to every value-taking option, including both model spellings):
  the value is the token immediately after the option. If that token **begins with a quote char**
  (§6a) and a matching close quote appears later, the value is the text between the quotes —
  spanning internal whitespace — with the surrounding quotes **removed**; its content is literal
  (no arg parsing, no backslash processing inside — WYSIWYG). Otherwise the value is the next
  whitespace-delimited token, verbatim (consumed even if it looks like another option, e.g.
  `--thinking --offline` sets thinking's value to `--offline`). There is **no** distinction between
  "single-value" and "multi-value" options — every value-taking option reads its value this way, so
  `-m gpt56s` ≡ `-m "gpt56s"` and `--system-prompt Psych` ≡ `--system-prompt "Psych"`.
  The dequoted value is stored as **one element** in `forwardedArgs`
  (e.g. `["--system-prompt", "I am psyched"]`), so pi's `parseArgs` maps it as a single value.
  If a value opens with a quote but has no matching close, fall back to the whitespace-delimited token.
- `--print`/`-p` is modeled as **boolean** here (pi's optional-value form would eat prose).

Value examples:
- `--system-prompt "I am psyched"` → value `I am psyched`.
- `--system-prompt "talk about -m modelname arg"` → value `talk about -m modelname arg` (inner `-m` not parsed).
- `--system-prompt "talk about \-m arg"` → value `talk about \-m arg` (backslash kept; no recursion).
- `-m "gpt56s"` → `forwardedArgs` contains `--model`, `gpt56s`.

### 3c. Blocked pi options — rejected
`-c`/`--continue`, `--theme <path>`, `--models`, `--export`, `--list-models`, `-h`/`--help`,
`-v`/`--version`.
Appearing in **args mode** (leading) → hard **error** for either command:
`"/<command> does not support <opt>; it would disrupt the background agent run."`

Blocked options stay declared so prose advisories remain truthful. In particular, singular
`--theme` is declared value-taking: `do it --theme ./theme.json` warns about
`--theme ./theme.json`, not just the option name. `--no-themes` is a separate supported
boolean and remains forwarded.

## 4. Classifying a leading token (args mode), in order
1. **Escaped** (starts with a quote char, or is a backslash-before-dash word) → prose; **flip**. No warning. (§6)
2. **Extension-owned or normalized option** (§3a) → consume (+ model value); stay in args mode.
3. **Blocked pi option** (§3c) → **error**.
4. **Known pi option** (§3b) → consume (+ value if value-taking); push raw token(s) to `forwardedArgs`; stay in args mode.
5. **Anything else** — unknown `--foo` / `-x`, or a non-dash word → **flip to prose**; no warning.

## 5. Warnings (prose mode only) — exactly one kind
While in prose mode, if an **unescaped, unquoted** token is a **recognized** option
(extension §3a, known §3b, or blocked §3c), append this advisory:

> ``<opt> [<value>] was included in the prompt body. To specify an argument or an option, place it at the beginning of the command input: /<command> <opt> [<value>] <first-prose-word> …``

- `<value>` appears only for value-taking options; it is the token that immediately follows in the input.
- `<first-prose-word>` is the first whitespace-delimited word of the prose.
- `<command>` is the actual command (`agent` or `agent-isolated`).
- Unknown arg-looking tokens in prose (`-g`, `--doesnotexist`) → **no** warning.
- Quoted or backslash-escaped option-looking tokens → **no** warning.
- Warnings never change the prose text.

Worked examples:
- `hello world -m gpt56s` → task = whole string; warn `-m gpt56s`, suggest `/agent -m gpt56s hello …`.
- `-m gpt56s hello --thinking high world` → `-m gpt56s` parsed; task = `hello --thinking high world`;
  warn `--thinking high`, suggest `/agent --thinking high hello …`.
- `-g badflagname hello world` → `-g` unknown → task = whole string; **no** warning.
- `hello world -g badflagname` → task = whole string; **no** warning.
- `--doesnotexist this is my message` → `--doesnotexist` unknown → task = whole string; **no** warning.

## 6. Escaping — opt a token out of arg parsing. NEVER recurses.

### 6a. Quotes — kept in prose; stripped ONLY when reading an option value
Quote chars: `` ` `` `'` `"` `‘` `’` `“` `”`. Matched pairs: `"…"`, `'…'`, `` `…` ``, `‘…’`, `“…”`.
- Inside a matched quote span: no token is treated as an option, and no warning fires.
- In **prose**, quotes are **kept verbatim** — they are ordinary characters that merely suppress
  arg parsing. The one exception is when a quote span is being read as an **option's value**
  (§3b): there the surrounding quotes are removed and the content becomes the value.
- Content inside quotes is literal; a backslash inside quotes is **not** processed (kept).
- A quoted span at the very start (not an option value) still flips to prose.
- An unmatched quote is just a literal character (no span, no effect).

Examples:
- `summarize "war and peace"` → task `summarize "war and peace"` (prose → quotes kept).
- `"\-m gpt56 hello"` (leading, not a value) → task `"\-m gpt56 hello"` (quotes kept, backslash kept, no arg parsing inside).
- `--system-prompt "war and peace"` → value `war and peace` (value → quotes stripped).

### 6b. Backslash-before-dash — the backslash IS removed
A backslash at the start of a word whose next char is `-` escapes that word:
- Remove the leading `\`; the word (now starting with `-`) is prose. Flip to prose if in args mode;
  if already in prose, still remove the backslash and emit no warning.
- Overly-cautious double form: after removing the leading `\` before `-`, if the next two chars are
  `\-`, remove that `\` too. So `\-\-word` → `--word`. One backslash also suffices: `\--word` → `--word`.
- A backslash **inside quotes** is not processed (see §6a).
- A backslash NOT immediately before a `-` is left literal (not an escape).

Examples:
- `\-m` → `-m`;  `\--thinking` → `--thinking`;  `\-\-thinking` → `--thinking`.
- `hello agent, \-m "gpt56s" how are you?` → `hello agent, -m "gpt56s" how are you?`.
- `hello agent, \--thi"nking" high` → `hello agent, --thi"nking" high`.

## 7. Application layer (`resolveForwardedOptions`) — simplified
`forwardedArgs` (known pi options only) is mapped to child-session inputs. The application
layer maps thinking, model/provider through `resolveCliModel`, tools/excludeTools/noTools,
and `resourceLoaderOptions` (system prompt, skills, extensions, prompt templates, and
supported no-* toggles including `--no-themes`). Singular `--theme` never reaches this
projection. There is no unknown-flag / `extensionFlagValues` path or runtime arity probe;
recognition and arity come from the shared declaration.

## 8. Wiring
- `parseAgentCommand` is pure and returns `warnings`.
- `startUserAgent` emits each warning via `ctx.ui.notify(warning, "warning")` inside the existing
  `if (ctx.hasUI)` block. Parse/blocked/usage errors keep flowing through `handleAgentCommand`'s
  try/catch to `reportCommandError` (unchanged).

## 9. Edge decisions (locked)
- Bare `-m` (no value) → usage error.
- Empty task after consuming options → usage error.
- Blocked option leading → hard error; in prose → warning.
- No `--` options terminator (backslash/quotes handle "task starts with a dash").
- Value-taking option with no following token → the option is still recorded (no value); no crash.
- Multiple known options in prose → one warning per occurrence, in order.

## 10. Pre-submit cursor analysis and eager autocomplete

Cursor analysis recognizes only exact `/agent` and `/agent-isolated` command lines. It
preserves the active token's source span and reports either an option fragment, a value
fragment with its owning declaration, or no completion once parsing has entered terminal
prose. Quoted and backslash-escaped dashes therefore never reopen option completion.

Typing `-` at a valid option position explicitly opens the menu without Tab. A single `-`
may match short and long spellings; `--` matches long spellings only. Every alias is shown as
its own row, but using either spelling suppresses the whole semantic option thereafter.
`/agent-isolated` seeds isolation as already present, so neither `-i` nor `--isolate` is
offered. Blocked and recognized-but-child-ineffective options remain parseable but are never
recommended.

The finite value domains implemented today are:

- thinking levels from the fixed Pi level set;
- unique providers from the live model registry;
- live canonical `provider/id` model references, filtered by a preceding `--provider` for
  either model spelling;
- tool names from the live public `pi.getAllTools()` catalog for `--tools`/`-t` and
  `--exclude-tools`/`-xt`.

Tool completion is local to the active comma-delimited segment. Accepting a tool replaces only
that segment and closes the menu without adding a space or comma. Typing `,` immediately opens
the next segment and excludes every tool already selected elsewhere in the value. The user
types a normal space to finish the complete tool list. Other non-path value options remain
guarded rather than pretending to have finite catalogs.

`--extension`/`-e`, `--skill`, and `--prompt-template` are path domains. Accepting one from
the option menu inserts the guarded slot and eagerly opens the shared filesystem pipeline.
Manually typing an exact path option and its value-boundary space eagerly opens the same
pipeline. Directories keep traversal inside the quotes; files finish after the single separator
outside the closing quote.

For `--skill` and `--prompt-template`, installed-resource shortcuts from public
`pi.getCommands()` entries are merged with native filesystem candidates. Shortcut filtering
uses the public command source (`skill` or `prompt`), and selection inserts the public
`sourceInfo.path` as one path value. Arbitrary filesystem fallback remains available.
`--extension` stays filesystem-only because command-backed extension discovery is incomplete.
Singular `--theme <path>` remains blocked and has no menu; `--no-themes` remains supported.

Accepting a boolean option, thinking level, provider, or model normalizes adjacent whitespace
to exactly one separator and puts the cursor after it. Tool values deliberately omit that
automatic separator until the user finishes the comma list. Accepting a guarded option puts
the cursor between the quotes while preserving the outer separator. Mid-line edits replace
only the active span and leave the suffix intact. Tab and Enter both chain finite value menus;
this includes Pi's asynchronous unique-result Tab path. An empty live domain produces Pi's
normal empty-picker outcome rather than fabricated candidates.

End-to-end editor tests use valid `.ts`, `SKILL.md`, and prompt Markdown fixtures for every path
option, including manual boundary eagerness, guarded recursive traversal, final cursor placement,
public shortcut insertion, filesystem fallback, and filesystem-only extension behavior.

## 11. Semantic token scan and editor coloring

`scanAgentArguments` is the single shared semantic representation behind both runtime parsing
and editor coloring. It runs the §2 state machine once and emits, alongside the
`ParsedAgentCommand` projections, an ordered list of non-overlapping semantic tokens with
source spans:

- `option` — a recognized, non-blocked leading option (extension-owned or forwarded);
- `value` — the value consumed by a leading value-taking option. A quoted value's span
  includes its surrounding quotes;
- `invalid-value` — a leading closed-set value rejected by the same canonical validation
  used at submission and session creation: Pi's argument parser for thinking levels, the
  child model resolver for model IDs and user-defined aliases, and the live provider and
  tool catalogs;
- `blocked` — a blocked option in args mode, plus the value a blocked value-taking option
  would consume (`--theme ./theme.json` yields two `blocked` tokens). Unlike
  `parseAgentCommand`, the scan never throws: it records the first blocked token and keeps
  scanning in args mode so later tokens still classify;
- `misplaced-option` / `misplaced-value` — the §5 advisory pair: a recognized, unquoted,
  unescaped option in prose and the token its warning cites as the value. A misplaced value
  that is itself a recognized option gets its own `misplaced-option` token instead.

Prose itself is never tokenized; unknown dash-words, quoted spans, and escaped words remain
plain. `parseAgentCommand` is a thin projection over the scan (blocked → hard error, blank
prose → usage error), so parsing and coloring cannot drift.

`scanAgentCommandLine` recognizes the same exact `/agent` / `/agent-isolated` prefix as
cursor analysis (§10) and shifts token spans into editor-line coordinates.

The editor coloring layer (`editor-coloring.ts`) maps token semantics onto Pi theme
variables — command `accent`, options `syntaxKeyword`, valid values `syntaxString`, and
invalid, blocked, or misplaced tokens `error` — by repainting the laid-out chunk text after
word-wrap layout, so editing, wrapping, cursor behavior, and autocomplete are untouched.
