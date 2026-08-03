# Resume the overlay tool-rendering research

## Task overview

The user wants the `pi-user-agents` overlay to render agent tool calls clearly. Agent text already uses Pi's native Markdown renderer. Tool calls currently appear as unattractive raw transcript text.

The target problem is visible here:

`/var/folders/28/9x0yw2vs4bzd8s3p7pyfs1kc0000gn/T/pi-clipboard-80f8593b-f25b-42c1-8027-ad4a614a14b6.png`

The user likes the built-in tool presentation in:

`/Users/giladbarnea/.pi/agent/extensions/rich-tool-diff/`

A separate extension provides the preferred pure Bash presentation:

`/Users/giladbarnea/.pi/agent/extensions/bash-rich-highlight.ts`

The user does not want extension reuse or shared dependencies. The eventual implementation may copy and adapt code directly into `pi-user-agents`.

This phase is research only. Do not edit the implementation yet. The goal is one joint, implementation-ready recommendation about what `pi-user-agents` can and should copy.

## Current state

The team completed most of the domain research and exchanged findings. No implementation files were changed.

The active team is `overlay-tool-styling`:

- `rich-tool-researcher` traced the `pi-user-agents` overlay in practice.
- `overlay-researcher` traced `rich-tool-diff` in practice.

The names and actual research domains became crossed during the first run. Preserve the work each session already contains instead of restarting by name.

Both sessions then exhausted their context windows. Follow-up prompts produced short, confused turns and no `teammain` report. The user has now compacted both sessions and switched their models. Treat the compacted session as retained research context, and use this document to restore direction.

## Important discoveries

### The overlay has its own historical transcript renderer

`pi-user-agents/widget.ts` renders captured assistant content inside the overlay. Near the previously inspected `render()` path, text content uses Pi's `Markdown` component. Tool-call content instead follows the overlay's basic transcript formatting. This split explains the screenshot.

The overlay has historical tool events and must present them itself. It does not automatically inherit the main transcript's visual tool components.

`runner.ts` creates child-session services through Pi's session-service path, so global extensions can affect the child session. That fact does not solve overlay rendering. The overlay later renders its captured transcript independently.

Pi's own transcript also treats these concerns separately. It uses an assistant component for Markdown text and a tool-execution component for tool calls and results.

### Do not embed Pi's live `ToolExecutionComponent`

The team converged against instantiating Pi's `ToolExecutionComponent` inside the overlay. That component resolves current registered tool definitions and models live execution state. The overlay displays captured history, including calls from child sessions whose current definitions may differ or no longer exist.

The safer boundary is a local historical renderer inside `pi-user-agents`. It should consume the data already captured in the agent transcript and return ordinary TUI components.

### `rich-tool-diff` deliberately covers six tools

`rich-tool-diff/FORK.md` and its registration code limit rich replacements to:

1. `read`
2. `edit`
3. `write`
4. `grep`
5. `find`
6. `ls`

The extension does not provide a universal renderer for every tool. It gives each supported tool a compact call summary and a purpose-built result view. The retained agent context contains the detailed rendering inventory for these six tools, including path treatment, counts, ranges, mutation previews, and diffs.

Bash presentation comes from `bash-rich-highlight.ts`, not `rich-tool-diff`.

### The proposed coverage is first-class known tools plus a fallback

The strongest scope proposal so far is:

1. Copy and adapt the six `rich-tool-diff` presentations.
2. Copy and adapt the pure Bash presentation.
3. Add one compact generic fallback for every custom or unsupported tool.

This avoids the current raw JSON appearance without pretending that arbitrary tools have known semantics.

The generic fallback should preserve the tool name, readable arguments, execution state, and available result text. It should not grow tool-specific branches without a known visual contract.

### Calls and results need historical pairing

The copy-and-adapt design must work from stored transcript data, not live tool definitions. Calls and results should pair through the captured tool-call identity and execution order. The retained research covered which call arguments, result content, and status fields are available. Reconcile that inventory before writing the final recommendation.

## Work already attempted

The team read the relevant Pi extension, TUI, SDK, theme, JSON-stream, changelog, and session material. It also inspected Pi's built-in tool renderers and the source for the two local extensions.

The agents shared findings successfully with each other. Their final report failed because both context windows were exhausted. The absence of a `teammain` message was a context-loss symptom, not evidence that teammate communication was unavailable.

Do not repeat broad documentation research. Use the compacted research state first. Read a source file again only when a concrete unresolved claim requires it.

## Resume from here

1. Read this document completely.
2. Tell your teammate what useful domain knowledge survived compaction.
3. Ask your teammate for any missing fact that blocks the joint recommendation.
4. Reconcile the overlay data model with the copied renderer inputs.
5. Agree on the exact first-class coverage and generic fallback boundary.
6. Send one joint report to `main` through `teammain`.

The report must explain:

- the current overlay rendering and data path
- why the current output looks raw
- what each source extension covers and does not cover
- the recommended local renderer boundary
- how historical calls and results should pair
- the exact first-class and fallback scope
- real Pi SDK constraints
- concrete unresolved decisions, if any

Keep implementation out of scope. Do not send only a normal assistant response. Use `teammain` so the main session receives the report.
