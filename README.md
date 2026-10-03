# claude-mods

**Panels, guardrails and quality-of-life mods for [Claude Code](https://claude.com/claude-code).**
See what's filling your context, how fast you burn through your plan, what Claude is running *right now*, block the commands you never want run, and discover the slash commands you didn't know existed.

Each mod is a small, standalone Claude Code plugin built on **function hooks** (the in-process plugin API). Install all of them or just the ones you want.

> **Requires Claude Code 2.1.286 or newer** (function hooks are early-access and the API may change between releases). Works in the terminal and the desktop app; panels need a surface that can dock a pane (desktop app, or a terminal ≥ 144 columns wide; narrower terminals open them inline).

---

## The mods

| Mod | Command | What it does |
|---|---|---|
| **quickbar** | `/quickbar` | One line above the prompt: live **context %** and a button for every claude-mods panel you have. Start here. |
| **context-keeper** | `/ctx` `/checkpoint` `/resume-checkpoint` | What fills your context window (messages, MCP tools, memory files…) with tips to trim it. **Checkpoints**: Claude writes a handoff note (goal, decisions, files, TODOs) to `.claude/checkpoints/` so you can `/clear` or `/compact` without losing the thread, then reload it in one click. Auto-archives the raw transcript before every compaction (zero tokens). Warns at 70%, auto-checkpoints at 85%. |
| **usage-meter** | `/meter` | 5-hour and 7-day plan-limit bars with reset countdown, **burn rate and "full in ~2.3h" estimate**, session cost, cache hit ratio (and why it's low), tokens-per-turn sparkline. Toasts at 80% / 95%. |
| **notify** | `/notifications` `/mute` | Notification inbox + **native OS notifications** (Windows, macOS, Linux) when a long turn finishes, a subagent or background task completes, Claude asks you a question, or **a tool call has been waiting for your approval** for 15s. |
| **activity** | `/activity` | Live panel: what Claude is doing *this second*: thinking, running `$ npm test` for 0m42s, **waiting for YOUR approval**, which subagents are running, and its current todo plan with progress. |
| **guardrails** | `/guard` `/guard-preset` | Clickable safety rules with presets (**Safe defaults**, **Locked to project**, **Read-only review**, Off): block `rm -rf`, force-push, destructive git, reading `.env`/keys, sudo, package installs, network; keep Claude inside the project folder; plus your own regex patterns. Saved across sessions. |
| **prompt-coach** | `/coach` | Before a *vague* prompt is sent, a fast model suggests a sharper rewrite. You pick **Send improved / Send mine / Edit improved**. Never rewrites silently; skips short replies like "yes", "continue". |
| **toolbox** | `/tools` | Every tool Claude can use (built-in + MCP, grouped by server) in plain language, how many times each was used, and **suggestions for the project you're in** (missing CLAUDE.md, browser MCP for web UIs, DB access, `gh`, verification steps…). |
| **command-hub** | `/cmds` `/new-command` | The built-in commands you're probably missing, explained ("when to use it"), a searchable list of every command, a **form to create your own** slash command, and tips when what you typed matches a command (e.g. "undo that" → `/rewind`). |
| **changes** | `/changes` | Every file Claude created or edited this session with `+/-` line counts, plus one-click "why?", "summarize all changes" and "self-review". |
| **loop-breaker** | (automatic) | Notices Claude going in circles (the same command failing 3× or one file patched 6× in a turn), tells you, and tells Claude to stop and rethink. |

---

## Install

### Option 1: inside Claude Code (recommended)

```
/plugin marketplace add OWNER/claude-mods
/plugin
```
Pick the mods you want from the **claude-mods** marketplace in the plugin browser.

### Option 2: from your shell

```bash
claude plugin marketplace add OWNER/claude-mods
```
```bash
claude plugin install quickbar@claude-mods
```
Repeat `install` for each mod (`context-keeper`, `usage-meter`, `notify`, `activity`, `guardrails`, `prompt-coach`, `toolbox`, `command-hub`, `changes`, `loop-breaker`).

### Option 3: just ask Claude

Paste this into Claude Code:

> Install the claude-mods plugins from github.com/OWNER/claude-mods. Follow its INSTALL-FOR-CLAUDE.md.

### Try without installing

```bash
git clone https://github.com/OWNER/claude-mods
```
```bash
claude --plugin-dir claude-mods/plugins/activity --plugin-dir claude-mods/plugins/quickbar
```

---

## Settings

Mods with options (thresholds, OS notifications on/off, reviewer model…) show them in `/config` once installed, or set them in `~/.claude/settings.json` under `pluginConfigs.<mod-name>`.

| Mod | Option | Default |
|---|---|---|
| context-keeper | `warnAt`, `checkpointAt` (0 = off) | 70, 85 |
| usage-meter | `warnAt` | 80 |
| notify | `minSeconds`, `osNotify`, `approvalWaitSeconds` (-1 = off) | 30, true, 15 |
| activity | `autoOpen` | false |
| prompt-coach | `enabled`, `model`, `minChars` | true, claude-haiku-4-5, 8 |
| loop-breaker | `failLimit`, `editLimit` | 3, 6 |

**Heads-up:** guardrails turns on its *Safe defaults* preset the first time it loads. `/guard-preset off` turns everything off.

---

## Honest limits

- **guardrails is a seatbelt, not a sandbox.** Rules are pattern checks on the commands and paths Claude passes to tools; a determined workaround (a script that deletes files) isn't caught. Use Claude Code's permission settings and sandboxing for hard guarantees.
- **prompt-coach** adds a ~1s model call (small model) to prompts it reviews, and uses a few tokens.
- **context-keeper checkpoints** ask the model for a summary over the cached conversation, so they cost a little (mostly cache reads). The pre-compaction archive is free.
- Function hooks are early access: a Claude Code update can break a mod. Issues and PRs welcome.

---

## Develop / contribute

```bash
npm install
```
```bash
npm run typecheck
```
```bash
npm test
```

- Each mod lives in `plugins/<name>/`: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `hooks/register.tsx`, and `types/index.d.ts` for its `$.state` contract.
- Type definitions for the API: run `/plugin-types` inside Claude Code in this folder (writes `.claude/types/`, git-ignored).
- `claude plugin validate plugins/<name>` must pass. It is stricter than `tsc` (e.g. helpers that take `$` must be top-level functions).
- Hot-reload while developing: `claude --plugin-dir plugins/<name>` reloads on save.
- Live-develop with Claude: ask Claude Code to "make a mod" and it will use its built-in plugin-authoring skill.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the mod checklist.

## License

MIT
