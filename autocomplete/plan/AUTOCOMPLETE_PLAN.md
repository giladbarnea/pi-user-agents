# Eager `/agent` argument autocomplete plan

> Status: follow-up implementation complete and independently reviewed; final static and live-TUI acceptance are in progress.  
> Updated: 2026-07-16.  
> This file is also the execution ledger; update the status table as work proceeds.

## Success means the editor and runtime cannot disagree

The finished interaction is:

1. The user types `/agent ` and then `-` at a cursor position where the command grammar permits another option.
2. An autocomplete menu visibly opens immediately, without Tab and without relying on incidental Pi editor behavior.
3. The menu contains every supported spelling not already semantically present, with labels such as `-m <model>` and `--thinking <level>`.
4. Accepting a boolean option or an enumerable value leaves exactly one trailing space and advances the cursor after it.
5. Accepting a free-form value option inserts an empty quoted slot plus a trailing separator—such as `--system-prompt "" `—and places the cursor between the quotes so typing is protected without escape anxiety.
6. If the option has enumerable values, its value menu opens immediately after the option menu closes.
7. If the option is path-valued, filesystem completion opens inside the guarded quotes and continues eagerly through directories.
8. Once command parsing has entered task prose, option autocomplete never reappears.
9. Submitted input and pre-submit editor input are interpreted by the same option declaration and state engine.

The delivered behavior explicitly triggers the real editor at valid option positions; it does not depend on incidental slash-command refreshes. The final automated suite contains 82 passing extension tests, including real `CustomEditor` rendering, Tab and Enter value chaining, live model/provider catalogs, guarded free-form and filesystem traversal, negative grammar states, mid-line editing, rapid request cancellation, and the blocked singular-theme policy.

---

# Pass 1 — The high-level path to done

1. **Continue from the approved policy with vertical TDD.** Make the current `-m`/`--model` RED test green before introducing the next focused behavior.
2. **Characterize the remaining runtime and editor behavior.** Preserve the parser contract and establish failing tests for the desired eager interaction before changing production code.
3. **Create one command-language engine.** Replace the independent option sets with one declarative specification and make both strict runtime parsing and cursor analysis consume it.
4. **Build pure completion behavior.** Derive option/value candidates and exact text edits from the engine’s cursor state.
5. **Wire the Pi editor deliberately.** Add a context-specific eager `-` trigger, the provider, and immediate option-to-value chaining while composing with the existing custom editor.
6. **Prove, document, and release it.** Run automated and interactive checks, update the authoritative grammar and user documentation, review the final diff, and reload Pi.

All completion-policy forks below are approved. Work proceeds in vertical RED→GREEN slices; do not write the remaining test matrix upfront.

---

# Pass 2 — Dependencies, forks, and delivery risk

## The graph has one policy gate and one critical implementation path

```text
A. Approve completion policy
            │
            ├──────────────┐
            ▼              ▼
B. Characterize parser   C. Characterize editor integration
            └──────┬───────┘
                   ▼
D. Introduce shared option specification + state engine
                   │
                   ├──────────────┐
                   ▼              ▼
E. Runtime parity projection   F. Pure cursor completion + edits
                   └──────┬───────┘
                          ▼
G. Pi provider + explicit editor trigger/retrigger bridge
                          ▼
H. Full verification + docs + reload
```

- **A blocks all product-facing behavior** because the first menu and second-menu promise depend on it.
- **B and C can run in parallel** after A. They are characterization, not implementation.
- **D is the structural root.** E and F may proceed in parallel only after D’s public analysis shape is stable.
- **G requires both runtime parity and pure completion** so integration cannot conceal disagreement between them.
- **H is sequential and mandatory.** The feature is not done merely because unit tests pass.

## Policy decisions and approved branches

### A1. Free-form and secret values — approved: guarded quoted slot

Some effective options accept arbitrary text rather than a finite candidate set, such as `--system-prompt` and `--append-system-prompt`.

Selecting one inserts the option, one separator, an empty quoted value, and one trailing separator. The cursor lands inside the quotes:

```text
/agent --system-prompt "│" 
```

The cursor is intentionally not at the end. The user types directly into the protected literal; the closing quote and the command’s trailing separator are already present. This is an editable empty value, not a fake placeholder and not a second menu.

### A2. Recognized options that do not affect the SDK child — approved: effective only

`resolveForwardedOptions()` currently applies model/thinking, tool, and resource-loader settings. Several other recognized Pi flags are parsed but have no child-session effect.

Autocomplete suggests only options that actually affect the child. Runtime parsing continues recognizing the legacy set so this feature does not silently change existing submitted-command behavior.

### A3. Aliases in the menu — approved: every spelling, semantic suppression

A single `-` prefix may match both short and long spellings, so both `-i` and `--isolate` appear as separate rows. Once the fragment becomes `--`, only long spellings remain. Selecting or manually typing either spelling marks the semantic option present and suppresses every alias thereafter.

### A4. Path-valued options — approved: eager quoted traversal

The path-valued options are `--extension`/`-e`, `--skill`, and `--prompt-template`. Their values identify a file or directory on disk.

Selecting one creates the same guarded shape—such as `/agent --skill "│" `—then immediately opens Pi’s filesystem menu inside the quotes. Selecting a directory keeps the cursor inside the quoted value and eagerly reopens the filesystem menu for the next segment. The closing quote and the command’s single trailing separator remain outside the traversal cursor, so recursive path completion does not require an exception to the spacing rule. Selecting a file moves the cursor after that separator: `/agent --skill "src/file.ts" │`. Manually typing an exact path option and its value-boundary space now opens the same filesystem menu eagerly without Tab.

### A5. Model options — approved: one CLI-backed semantic option

`-m` and `--model` are aliases. Both project to Pi’s `--model` input and resolve once through `resolveCliModel()`; `--provider` scopes either spelling. Selecting or typing either alias suppresses both in completion.

### Locked decisions

- A single `-` fragment may offer both short and long spellings; a `--` fragment offers only long spellings.
- An already present semantic option is hidden under every alias, even if the runtime happens to accept repetitions. Users can still type a repeated option manually.
- `/agent-isolated` begins completion analysis with isolation already satisfied, so it does not suggest `-i` or `--isolate`.
- A completion domain receives its live catalog unchanged; an empty catalog is Pi’s normal picker outcome, not command-language policy.
- Selecting a file leaves the cursor after the preserved outer separator; selecting a directory keeps it inside the quotes.
- Blocked options remain recognizable for runtime errors and prose warnings but never appear in completion.
- Unknown dash-prefixed tokens preserve today’s runtime rule: they commit the remainder to prose rather than becoming parser errors.

## Node assessment

| Node | Needs Gilad | Complexity / risk | Rough diff | Reversibility |
|---|---|---|---:|---|
| A. Policy | Approved | Low technical risk; high UX leverage | Documentation only | Immediate |
| B. Parser characterization | No | Low; protects subtle quote/escape behavior | Small tests | Delete tests |
| C. Editor characterization | No | Medium; asynchronous menu lifecycle and custom-editor composition | Small–medium tests/harness | Delete harness |
| D. Shared engine | No after A | Medium–high; highest regression surface | Medium, mostly move/delete | Restore parser block |
| E. Runtime projection | No | Medium; guarded by 61 parser/forwarding and 4 widget tests | Small–medium | Revert import/projection |
| F. Pure completion | No | Medium; cursor spans and whitespace edits | Medium | Remove isolated module |
| G. Pi integration | No | Medium–high; private editor trigger seam | Medium | Remove registration/decorator |
| H. Verify/docs/reload | Final feel check useful | Low code risk | Small | Documentation revert/reload |

---

# Pass 3 — Specific implementation checkpoints

## 1. Lock behavior and write characterization tests

### Behavioral pseudocode

> Treat visible TUI behavior as the contract. Record representative command text and cursor positions, then distinguish argument, expected-value, and terminal-prose states. Pin all existing runtime behavior before introducing a shared engine. Add an editor-level failing case proving that `/agent -` currently opens no menu and that the desired implementation must open one without Tab or a pause-dependent race.

### Definition of done

- The 61 parser/forwarding tests in `tests/runner.test.ts` and four widget tests in `tests/widget.test.ts` remain green; `tests/command-line.test.ts` carries only the current focused RED behavior.
- Each desired behavior—option menu, value-menu chain, exact trailing space, duplicate suppression, prose cutoff, `/agent-isolated`, and cursor-in-the-middle—enters through one focused RED→GREEN test rather than a batch written upfront.
- At least one editor-facing test fails against the current implementation for the right reason: no visible menu appears after `/agent -`.
- Test fixtures distinguish a provider request from a rendered non-empty suggestion menu.
- All tests live under `tests/`; a test-only editor harness is added only when the editor tracer needs it.

### Falsifying criteria

This checkpoint is not done if:

- the tests only call a suggestion function directly and never prove the editor opens a menu;
- desired tests already pass without the feature because they assert an internal callback rather than behavior;
- quote, escape, warning, blocked-option, or leading-whitespace behavior is left uncharacterized;
- fixtures contradict any approved policy above.

### Kept out of scope

No production refactor, no Pi core patch, and no expansion of child-session option semantics.

---

## 2. Replace option sets with one declarative specification and scanner

### Intended source of truth

Add `command-line.ts` with one ordered option declaration. Each semantic option records:

- accepted names and preferred completion spelling;
- extension-owned, forwarded, or blocked role;
- boolean or value arity;
- placeholder and optional value-completion domain;
- whether autocomplete may suggest it;
- concise user-facing description.

All name maps, arity checks, warnings, blocked checks, forwarding behavior, labels, and completion domains are derived from that declaration. No second list of option spellings or arities is permitted. `-m` and `--model` form one forwarded model declaration; its runtime projection invokes `resolveCliModel()` once with the optional parsed provider, and removes the extension-owned `modelReference` path.

### State model

```text
ARGUMENTS
  recognized boolean ───────────────→ ARGUMENTS
  recognized value option ──────────→ EXPECT_VALUE(option)
  blocked option ───────────────────→ ERROR in strict runtime mode
  unknown/escaped/quoted/prose word ─→ PROSE

EXPECT_VALUE(option)
  next value token ─────────────────→ ARGUMENTS
  end of input ─────────────────────→ INCOMPLETE

PROSE
  every remaining token ────────────→ PROSE
```

`PROSE` is terminal. Cursor analysis may observe a partial option token before it is committed as prose; strict submission retains today’s exact-token behavior.

### Behavioral pseudocode

> Scan leading command input once while carrying a tagged state. Resolve option tokens through the single specification, consume one value token when required, and permanently enter prose on the first non-option token. Preserve token source spans, quote metadata, and the original prose offset. When a cursor is supplied, report the grammar state immediately around its active token plus the exact fragment span that completion may replace. Project strict runtime output from the same scan, applying the existing errors, warnings, dequoting, and backslash rules.

### Definition of done

- All 61 existing parser/forwarding tests in `tests/runner.test.ts` pass without weakening assertions.
- `runner.ts` no longer declares option-name or arity sets and only imports the parser projection.
- Runtime recognition, prose warnings, blocked errors, and editor cursor state resolve through the same option index.
- Cursor analysis can return:
  - an option fragment and replacement span;
  - a value fragment, owning option, and replacement span;
  - no completion because the cursor is in prose or another invalid position.
- A repository search finds every supported option spelling in the specification or documentation/tests only—not in competing production tables.
- The implementation stays a flat state-machine scan. No ornamental AST, recursive fold, parser-combinator framework, or candidate-specific reparsing is introduced.

### Falsifying criteria

This checkpoint fails if:

- runtime and editor require separate scanners or special-case option lists;
- any existing parser fixture changes output unintentionally;
- cursor support requires mutating the input before the normal scan;
- quote/backslash handling is simplified in a way that changes `PARSER_SPEC.md`;
- the abstraction is larger or harder to follow than the current parser plus the completion need justifies.

### Kept out of scope

No shell grammar, `--option=value`, `--` terminator, nested syntax tree, general-purpose command parser, or change to Pi’s own `parseArgs()`.

---

## 3. Derive suggestions and exact edits as pure behavior

### Behavioral pseudocode

> Given cursor analysis and a live completion catalog, return unused option spellings when the grammar expects an option and matching candidates when it expects an enumerable value. A candidate owns its insertion text, display metadata, and cursor destination. Applying a normal candidate replaces only the reported active span, normalizes adjacent separator whitespace, appends exactly one space, and places the cursor after it. Applying a free-form option instead inserts an empty quoted value plus the trailing separator and places the cursor between the quotes. Preserve every unrelated character and re-scan the edited command to prove runtime agreement.

### Definition of done

- `/agent -` yields every approved short and long spelling in specification order.
- Prefix shape filters spellings correctly: `-` may show both forms, `--` shows only long forms, and `--thi` narrows to `--thinking <level>`.
- Using any alias hides the semantic option under every alias.
- Blocked, policy-excluded, and command-inapplicable options do not appear.
- `/agent-isolated -` omits every isolation spelling.
- Value candidates come from truthful live/finite domains, initially including model references and thinking levels under the approved policy.
- A path-valued option produces the guarded quoted slot plus a path expectation that targets the cursor inside the quotes; directory candidates preserve that expectation for recursive traversal.
- Accepting every boolean option and enumerable value produces exactly one trailing space, even when whitespace already follows the cursor.
- Accepting a free-form option produces an exact guarded slot such as `--system-prompt "" ` and places the cursor between the two quotes while retaining the separator after the closing quote.
- Mid-line completion preserves the prefix and suffix outside the active fragment and returns the exact expected cursor location, including non-terminal cursor placement inside a quoted slot.
- Re-scanning every applied candidate proves the editor never manufactures input that the runtime engine interprets differently.

### Falsifying criteria

This checkpoint fails if:

- candidate generation can suggest a runtime-blocked or already-used semantic option;
- accepting a completion replaces the entire `/agent` argument prefix;
- whitespace can become zero or two spaces at the edit boundary;
- a candidate needs UI state hidden outside its returned edit description;
- a guarded free-form slot omits either quote, loses the separator after the closing quote, or places the cursor outside the quotes;
- completion logic knows an option spelling or arity not obtained from the shared specification.

### Kept out of scope

No TUI rendering, provider chaining, editor triggering, fuzzy-search framework, recent-value history, or generic completion DSL.

---

## 4. Wire a provider and an explicit context-scoped editor bridge

### Why an explicit trigger is required

Today, `-` does not visibly open the requested menu. The integration must therefore trigger autocomplete deliberately after the editor has inserted `-` and the shared engine confirms that the cursor is at an option position. It must not rely on Pi’s incidental slash-command refresh behavior.

A global `triggerCharacters: ["-"]` is also undesirable: it would wake the provider for ordinary prose hyphens. The existing custom-editor bridge is already necessary for immediate option-to-value chaining, so it should own both explicit transitions and ask the shared engine whether either is valid.

### Behavioral pseudocode

> Wrap the currently installed editor compositionally and forward all normal input first. After a typed dash is installed, inspect the editor text and cursor through the shared engine; if it reports an option fragment at that cursor, explicitly request autocomplete. The provider intercepts only exact `/agent` and `/agent-isolated` command lines and delegates every other context unchanged. After applying an enumerable value-taking option, wait until Pi has installed the edit and closed the first picker, then explicitly request its value menu. After applying a free-form option, leave the cursor inside the inserted quotes and do not open a synthetic menu. After applying a path option, force Pi’s path provider inside the quotes; after a directory candidate, force it again from the new inner cursor. Store no grammar logic in the editor bridge.

### Definition of done

- Typing `/agent -` visibly opens a non-empty option menu immediately without Tab.
- The same works under rapid typing when an earlier slash-command request/menu is still settling.
- Typing `-` in ordinary prose, another slash command, task prose after `/agent`, quotes, or an escaped token does not open the agent option menu.
- Accepting an enumerable value-taking option by either Tab or Enter inserts the option plus one space and visibly opens its value menu.
- Accepting a free-form value-taking option by either key inserts the guarded quoted slot, leaves the required trailing separator after the closing quote, and places the cursor between the quotes without opening a fake menu.
- Accepting a path-valued option creates the guarded slot and immediately opens filesystem completion inside it.
- Accepting a directory keeps the cursor inside the closing quote and immediately opens the next filesystem level; accepting a file finishes the value while preserving exactly one separator outside the quote.
- Accepting a boolean option inserts one trailing space and closes the menu without submitting the command.
- Accepting an enumerable value inserts one trailing space and returns to normal typing.
- The provider delegates native slash, inline-skill, attachment, and file completion unchanged outside its exact context.
- The editor wrapper composes with `inline-commands` regardless of extension setup order and does not decorate the same editor instance twice.
- A focused integration test fails loudly if Pi removes or renames the runtime autocomplete trigger method used by the bridge.
- `/reload` tears down and reinstalls the provider/editor composition without accumulating wrappers.

### Falsifying criteria

This checkpoint fails if:

- the menu appears only after Tab, a pause, or the next typed character;
- `-` is installed as a global trigger and causes unrelated autocomplete churn;
- provider code reparses with a second grammar;
- the second menu opens before the first completion edit is visible;
- Enter submits an incomplete option/value interaction instead of remaining in the editor;
- free-form completion leaves the cursor at the end rather than inside the quotes;
- path completion waits for Tab, moves the cursor outside the quotes, loses the outer separator, or stops after a directory;
- reloading or another editor extension loses or duplicates the bridge;
- success is inferred from `getSuggestions()` calls without verifying a visible menu state.

### Kept out of scope

No Pi core modification, public autocomplete API proposal, custom menu component, editor rewrite, syntax coloring, or support for editors that do not implement Pi’s current runtime autocomplete capabilities.

---

## 5. Verify the whole contract, update docs, and release

### Behavioral pseudocode

> Run the complete automated suite, inspect the structured diff for duplicated grammar and unrelated edits, then reload Pi and walk the interaction matrix in the real TUI. Update the authoritative parser specification and README only after observed behavior matches the tests. Treat any parser/editor disagreement or pause-dependent menu as a release blocker.

### Definition of done

Automated checks:

- all original 61 parser/forwarding tests in `tests/runner.test.ts` and four widget tests in `tests/widget.test.ts` pass;
- new scanner, cursor, edit, provider, and editor lifecycle tests pass;
- tests cover both commands, Tab and Enter, rapid typing, aliases, duplicates, blocked options, quotes, escapes, prose cutoff, mid-line cursor positions, and exact whitespace;
- the target extension passes its normal type/static checks without unrelated lint cleanup.

Real-TUI checks after `/reload`:

| Interaction | Expected result |
|---|---|
| `/agent -` | Option menu opens immediately |
| `/agent --thi` | Menu filters to `--thinking <level>` |
| Accept `--thinking <level>` | Editor becomes `/agent --thinking ` and level menu opens |
| Accept `high` | Editor becomes `/agent --thinking high ` |
| Accept `-m <model>` | Model menu opens immediately |
| Accept `--system-prompt <text>` | Editor becomes `/agent --system-prompt "│" `; cursor is between quotes |
| Type inside the guarded slot | Text remains inside quotes; separator remains after the closing quote |
| Accept `--skill <path>` | Editor creates `/agent --skill "│" ` and eagerly opens filesystem entries |
| Accept a directory | Cursor stays inside quotes and the next filesystem menu opens immediately |
| Accept a file | Quoted path is complete; exactly one separator remains after it |
| Accept a boolean option | Exactly one trailing space; no value menu |
| Type another `-` | Used semantic options are absent under every spelling |
| `/agent-isolated -` | Isolation option is absent |
| `/agent explain -` | No option menu; parser is in prose |
| `/agent \-` or quoted dash | No option menu |
| Complete in the middle | Only active fragment changes; suffix remains |
| Type quickly through `/agent -` | No race or missing menu |
| `/reload`, then repeat | Exactly one provider/bridge remains active |

Documentation and delivery:

- `PARSER_SPEC.md` describes cursor expectations, spelling/alias eligibility, value-domain behavior, guarded quoted slots, cursor destinations, and the exact trailing-space rule.
- `README.md` gives the user-visible happy path and explains enumerable menus, guarded free-form values, and the approved path behavior.
- `gsd` shows only task-justified changes in `pi-user-agents`.
- The plan ledger is updated with test commands, results, and any approved deviations.

### Falsifying criteria

The feature is not releasable if:

- any original parser fixture regresses;
- the real TUI differs from the provider unit tests;
- a menu depends on timing;
- docs promise a second menu for a value domain that can return no candidates;
- recognized no-op options are recommended without the approved policy;
- the final diff contains a generic parser/autocomplete framework or unrelated cleanup.

### Kept out of scope

No redesign of child-agent execution, no implementation of currently ignored CLI flags, no changes to widgets/transcripts/result delivery, no Pi package upgrade, and no upstream API patch.

---

# Expected file impact

| File | Planned role |
|---|---|
| `command-line.ts` | Single option specification, state-machine scan, strict runtime projection, cursor analysis |
| `autocomplete.ts` | Pure candidate/edit adapter plus Pi provider/editor bridge wiring |
| `runner.ts` | Remove embedded parser tables/logic; import strict parser |
| `index.ts` | Register autocomplete/editor integration for the two commands |
| `shared.ts` | Only shared types that genuinely cross module boundaries |
| `tests/runner.test.ts` | Preserve runtime contract |
| `tests/command-line.test.ts` | Focused command-line policy tests, including blocked singular theme |
| `tests/autocomplete.test.ts` and `tests/editor-harness.ts` | Real-editor lifecycle behavior; add only when the UI tracer requires them |
| `PARSER_SPEC.md` | Authoritative editor + committed-input grammar |
| `README.md` | User-facing completion behavior |

`widget.ts` and `transcript.ts` should not change.

# Rollback and reversibility

The feature is extension-local. A rollback removes the provider/editor registration and the two new cohesive modules, then restores the parser block in `runner.ts`. No persisted session format, command invocation format, or child-agent result format changes. Existing commands remain usable through manual typing throughout the work.

# Minimality self-check

The earliest point at which the user receives the requested value is node G: the real editor opens and chains menus. Nodes A–F are prerequisites for correctness and the requested single source of truth; H is required to prove the real interaction rather than merely infer it.

Deliberately excluded complexity:

- no recursive AST for a linear grammar;
- no generic parser or autocomplete framework;
- no Pi core patch;
- no expansion of child-session semantics;
- no fabricated selectable values for free-form arguments—the empty quotes are an editable literal slot;
- no path-navigation exception to the universal trailing-separator rule; path traversal stays inside that quoted boundary;
- no refactor of unrelated agent execution or UI code.

# Execution ledger

| Node | Status | Evidence / decision |
|---|---|---|
| A. Approve completion policy | Complete | A1 guarded slots; A2 effective only; A3 semantic suppression; A4 eager quoted path traversal with cursor after a file’s outer separator; A5 `-m`/`--model` CLI parity |
| B. Characterize parser | Complete | Original runtime fixtures remain green; `-m` and `--model` now parse identically through the shared declaration |
| C. Characterize editor | Complete | Real `CustomEditor` harness observes rendered non-empty menus rather than provider requests |
| D. Shared engine | Complete | `command-line.ts` is the only production option grammar and owns strict parsing plus cursor state |
| E. Runtime projection | Complete | `runner.ts` consumes the shared parser; model resolution uses Pi's CLI path once |
| F. Pure completion | Complete | Prefixes, semantic suppression, live domains, exact edits, guarded slots, paths, and mid-line spans are covered |
| G. Pi integration | Complete | Context-scoped explicit trigger, enumerable/path chaining, bounded async unique-Tab observation, composition, and reload safety are implemented |
| H. Verify/docs/reload | Complete | Shipped release and live `/reload` acceptance remain valid; the root `/agent -` menu now contains 31 items after removing singular theme |
| Post-release blocked-theme policy | Complete | Vertical TDD rejects value-taking `--theme <path>` for both commands, preserves `--no-themes`, removes theme autocomplete/path projection, and brings the full suite to 82 pass, 0 fail |
| Live tool domains | Complete | Both tool options use live `pi.getAllTools()` candidates. Acceptance inserts no delimiter; comma eagerly opens the next segment and suppresses selected tools. |
| Path hardening | Complete | Every path spelling eagerly opens native completion after manual entry; valid per-resource fixtures preserve guarded recursive traversal and cursor behavior. |
| Installed resource shortcuts | Complete | Public `pi.getCommands()` skill/prompt entries contribute path-valued shortcuts beside filesystem fallback; extensions remain filesystem-only. |
| Follow-up verification and docs | In progress | Three independently reviewed behavior checkpoints are green; final full-suite/static/adversarial and live `/reload` acceptance remain. |

## The approved follow-up is implemented through stable vertical checkpoints

The live-tool checkpoint made `--tools`/`-t` and `--exclude-tools`/`-xt` truthful against
`pi.getAllTools()`. Completion replaces only the active comma segment, inserts no delimiter,
opens the next segment on a typed comma, and excludes already selected tools. The focused
checkpoint was independently accepted at 84 pass, 0 fail.

The path checkpoint added valid extension, skill, and prompt fixtures for every path spelling.
Manually typing an exact option and its value-boundary space now forces native filesystem
completion without Tab, while guarded directory traversal and final-file cursor placement remain
unchanged. The independently accepted checkpoint reached 85 pass, 0 fail.

The installed-resource checkpoint merges public `pi.getCommands()` skill and prompt entries with
native filesystem candidates and inserts their `sourceInfo.path` values. Guarded paths containing
spaces remain one quoted value. Extension commands are intentionally ignored because their public
catalog is incomplete, so `--extension` remains filesystem-only. This checkpoint was independently
accepted at 87 pass, 0 fail; the subsequent adversarial tool-cursor/live-catalog case brings the
current automated suite to 88 pass, 0 fail.

No theme menu was added. Singular `--theme <path>` remains blocked, `--no-themes` remains
supported, and the implementation adds neither a second option grammar nor a generic completion
framework.
