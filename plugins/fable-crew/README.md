# fable-crew

**Your biggest model leads. Cheaper models do the legwork.**

Fable 5.2 costs $8 per million input tokens and $40 per million output. Haiku 5.5 costs $0.10 and $0.50 (for prompts up to 100K tokens). That is 80 times less. Yet in a normal Claude Code session the big model also does the cheap work: it greps the repo, reads whole files to find one function, and scrolls through 400 lines of passing tests.

fable-crew splits the work:

| Who | Model | Does |
|---|---|---|
| **The lead** | whatever `/model` is set to (built for `fable`) | understands the task, plans, reviews the final diff |
| `scout` | haiku | read-only search: where things are, what a log says |
| `builder` | sonnet | implements one planned step and runs its check |
| `checker` | haiku | runs tests/builds, returns pass/fail and the failing lines |

It is three subagent files and one skill. No hooks, no scripts, nothing running in the background.

## Install

```
/plugin marketplace add mishgoldenberg/claude-mods
/plugin install fable-crew@claude-mods
```

## Use

```
/model fable
/fable-crew:crew add rate limiting to the upload endpoint, with tests
```

The lead sends scouts to find the code, writes a short plan, hands each step to a builder, sends the checker to run the tests, then reads the diff itself before reporting back.

The subagents also work on their own, without the skill: Claude picks `scout` or `checker` when a task matches their description, or you can ask for one by name.

## Honest notes

- **No savings number is promised.** How much the lead's usage drops depends on the task. Search-heavy and test-heavy work moves the most tokens to the cheap models; a small edit in one file moves none, and the skill tells the lead to just do those itself.
- **Handoffs lose detail.** A subagent only knows what the lead writes in its brief. That is why the lead still reviews the diff, and takes over when a builder fails twice.
- **Fable may bill to usage credits** on your plan (the `/model` picker tells you). The crew models count toward your plan the usual way.
- Prices are the list prices on [the Claude pricing page](https://platform.claude.com/docs/en/about-claude/pricing), read on 2026-11-10.
- To change a crew member's model, edit the `model:` line in its file under `agents/`.

MIT, like the rest of [claude-mods](https://github.com/mishgoldenberg/claude-mods).
