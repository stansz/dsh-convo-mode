# Conversation Mode

A per-session **conversation mode** for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness):
the same agent, told to be a conversational assistant instead of a coding agent, with coding
tools out of reach. It is a DSH bundle — a `cordis.patch.yml` row plus a Host plugin and a
Web client plugin — so it installs into a profile and applies to every session in it.

## Install

The bundle is a DSH profile plugin. Install it into a profile the same way the other
GitHub-hosted bundles (`dsh-frontend-review`, `dsh-git`, …) are installed:

1. **From the GitHub URL** (preferred): in the Web UI, open **Plugins → install a bundle**
   and point it at `https://github.com/stansz/dsh-convo-mode`. The plugin manager
   resolves the package, adds it to the profile, and activates it — no restart needed.
   The repository is **private**, so the machine must be signed in to GitHub as `stansz`
   (for example `gh auth status` shows that account).
2. **From a local clone**: `git clone git@github.com:stansz/dsh-convo-mode.git`, then
   install that directory as a bundle (Plugin Manager → install local bundle / the same
   package-directory install the other local bundles use).

Either route mounts one row, `id: dsh-convo-mode`, name `dsh-convo-mode`.
A profile is shared by every session in it, so the mode is available in all workspaces of
that profile.

## Use

- Click the **Chat** chip at the left of the composer tool row, or type `/conversation`.
- `/conversation <message>` enters the mode *and* sends the message in one step.
- `/conversation off` leaves it; the chip toggles too.
- The mode is stored in the session log, so it survives resume, fork, and restarts, and it
  is per session: other sessions, subagents, and teammates keep the normal coding setup.

## What the mode changes

1. **Prompt.** One additive system-prompt section reframes the assistant: natural prose,
   length matching the question, no unsolicited artifacts, one clarifying question instead
   of a guess, and code only as an illustration in the chat.
2. **Tools.** While active, the agent scope is restricted to a read-only allow list
   (`read`, `glob`, `grep`, `read_image`, web search/fetch, `ask_user_question`, `skill`,
   and the session-history readers). File writes, edits, shells, jobs, terminals,
   delegation, and workflow tools are not presented to the model and cannot be called.
   The restriction is registered on that one agent and disposed when the mode leaves.

## Configure

Two equivalent surfaces:

- **Settings → Plugins → Conversation Mode → Configure** in the Web UI (the row carries a
  Config schema: guidance text, read-only vs unrestricted tools, the allow list, and
  "start sessions in the mode").
- A `config` override in the profile patch (`$DSH_HOME/profiles/<profile>/cordis.patch.yml`).
  The row was inserted by this bundle, so it is targeted by id; `config` replaces the row's
  config wholesale:

```yaml
- id: dsh-convo-mode
  config:
    section: |                # model-facing guidance while active
      Be a warm, concise conversational partner...
    tools: readonly           # or "unrestricted"
    allow: [read, web_search] # override the read-only allow list
    defaultActive: false      # true starts every session in the mode
```

Validated at load: an unknown key or wrong type fails the plugin instead of being
silently ignored.

## Test

The Host half is covered by a dependency-free test that drives the plugin with a fake
Cordis context (projection folding, prompt section, command edge cases, per-agent tool
policy, config validation):

```sh
node test/host-half.test.mjs   # prints ALL HOST HALF TESTS PASSED
```

## Implementation notes

- Durable state is the `conversation` session projection folding the logged
  `command/run`/`command/done` pair for `/conversation`; no private session event type is
  appended, so sessions stay reopenable and old logs stay valid.
- The tool policy asks for the agent's own tool view (`schemas(agent)`), because presets
  compose tools onto an ancestor agent scope where the global view does not see them.
- The client half registers one chip in `conversation.input.left`; it reads the
  Host-computed projection and toggles by executing the same slash command.
- All styling uses `--dsw-alias-*` theme tokens; no Harness Client package is imported.

## License

MIT — see [LICENSE](LICENSE).
