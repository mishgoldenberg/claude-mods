# Fable 5.2 in Claude Code: one-page cheat sheet

Everything here was read from the official pages linked at the bottom on **2026-11-10**. Prices and plan rules change; check the links before you rely on a number.

## Switch to it

```
/model fable
```

- Model ID for the API and settings: `claude-fable-5-2`
- Needs Claude Code **v2.1.321** or newer (`claude --version`, then `claude update`)
- 1M-token context window, up to 128K output tokens

## What it costs (API list price, per million tokens)

| Model | Input | Output |
|---|---|---|
| **Fable 5.2** | $8 | $40 |
| Fable 5.2, fast mode | $16 | $80 |
| Opus 5.5 | $4 | $20 |
| Sonnet 5.5 | $2 | $10 |
| Haiku 5.5 (prompts up to 100K tokens) | $0.10 | $0.50 |

Fable 5.1 was $10 / $50, so 5.2 is cheaper than the model it replaces. It is still 80 times the price of Haiku per token.

On a subscription, look at the `/model` picker: it tells you whether Fable counts toward your plan or bills to usage credits.

## Fast mode: read this before you turn it on

```
/fast
```

- Same model, output up to 2.5x faster
- **Twice the price** ($16 / $80)
- On Pro, Max and Ultra it is billed to **usage credits** and is not part of your subscription limits
- The same command turns it off

Worth it when you are sitting and waiting on an urgent fix. Not worth it for a long job that runs while you do something else.

## Effort

```
/effort low | medium | high | xhigh | max
```

Higher effort means more thinking tokens per turn, so more cost and more waiting. Set it per task instead of leaving it on the highest level. Also available as `--effort`, the `effortLevel` setting, and `CLAUDE_CODE_EFFORT_LEVEL`.

## Don't pay the big model for small work

Subagents can run on a cheaper model than your main session. In an agent file:

```yaml
---
name: scout
model: haiku
tools: Read, Grep, Glob
---
```

[fable-crew](../plugins/fable-crew) is a ready-made set: the lead model plans and reviews, a `scout` on Haiku searches, a `builder` on Sonnet implements, a `checker` on Haiku runs the tests.

```
/plugin marketplace add mishgoldenberg/claude-mods
/plugin install fable-crew@claude-mods
```

No savings percentage is promised: it depends on how much of your task is searching and test output.

## Sources

- Pricing: https://platform.claude.com/docs/en/about-claude/pricing
- Fable 5.2 overview: https://platform.claude.com/docs/en/models/fable-5-2/overview
- Fast mode: https://code.claude.com/docs/en/fast-mode
- Models and effort in Claude Code: https://code.claude.com/docs/en/model-config
- Subagents: https://code.claude.com/docs/en/sub-agents
- Changelog: https://code.claude.com/docs/en/changelog
