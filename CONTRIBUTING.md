# Contributing a mod

1. Copy the shape of an existing mod (`plugins/changes` is a small one with a pane; `plugins/loop-breaker` has no UI).
2. Name the folder, the `name` in `plugin.json`, and the `plugin` in every `atom({ plugin, key })` the same.
3. Every `$.state` value you use must be declared in `types/index.d.ts` under your mod's name.
4. Helpers that receive `$` must be **top-level** `function` declarations (the validator rejects closures that take `$`).
5. Never shadow `on`, and always spell engine calls as `$.noun.method(...)`.
6. Draw from `$.ui.resolve(e)` and check optional elements (`'Input' in els`): mobile has no `Input`/`Select`.
7. Write from handlers (`onPress`, events), never inside a `ui.render` hook.
8. Add your mod to `.claude-plugin/marketplace.json` and the README table.

Before opening a PR:

```bash
npm run typecheck
```
```bash
npm test
```
```bash
claude plugin validate plugins/<your-mod>
```
```bash
claude plugin validate .
```

Then try it live: `claude --plugin-dir plugins/<your-mod>`.

Good mods: solve one annoyance, cost zero tokens unless clearly worth it, never surprise the user (ask before changing prompts or blocking work), and say honestly what they can't do.
