# Development

This is a Pi extension. Read ~/.pi/AGENTS.md to study Pi.
Read all the root docs. Understand the developer’s request. Then dispatch a Luna (or similarly "flash"-level model) with thinking=high to retrieve a list of all the Pi docs relevant to this extension’s architecture and user’s request.

## CICD

This extension is packaged (auto patch-bumped) and published on NPM automatically on push in a GitHub workflow. Publishing to NPM means it is also "published" to Pi.dev extension community (not really published — pi.dev just references the right NPM packages).

## Product design

**> Everything comes down to design, user experience, empowering the user with actual productivity added value, and instilling trust as they use the extension more.** Every development, product and design decision has to be justified by that touchstone.

This extension is public and I’m hoping it gains popularity at some point, so keep commits and user-facing vectors high quality. User-facing vectors, in no particular order, are (i’m basically breaking down what “product design” means to this project):
- TUI-rendered design. well-designed here means information hierarchy, progressive disclosure, transparency and a feeling of control, visual beauty, all while not generating cognitive load — quiet the opposite (*relieving* cognitive pressure).
- usability and UX. no learning curve, "just works", delightful.
- the README.md

## Testing

Reproduce / baseline tests run first thing.

**Automatic testing:**
We do high quality TDD. Load related skills.
Not everything can be tested programmatically, though. We lean on manual tests for that reason.

**Manual (behavior) testing:**
Launch Pi in a tmux session and prompt the main agent as your use-case requires.

Basic sanity flow — use it as a skeleton for testing the behavior you want.
1. Use cheap & competent models with `high` thinking levels. As of Aug 2026, an example is gpt-5.6-luna. Peek at `jq '{defaultModel, defaultThinkingLevel, enabledModels}' ~/.pi/agent/settings.json` to get user’s favorite model IDs.
2. In tmux: `/abs/path/to/pi --model <fullmodelid> --thinking high --no-extensions --extension /abs/path/to/here/`
3. Test the extension behaviors