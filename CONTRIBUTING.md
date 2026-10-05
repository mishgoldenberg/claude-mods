# Contributing a mod

1. Copy the shape of an existing mod (`plugins/changes` is a small one with a pane; `plugins/loop-breaker` has no UI).
2. Name the folder, the `name` in `plugin.json`, and the `plugin` in every `atom({ plugin, key })` the same.
3. Every `$.state` value you use must be declared in `types/index.d.ts` under your mod's name.
4. Helpers that receive `$` must be **top-level** `function` declarations (the validator rejects closures that take `$`).
5. Never shadow `on`, and always spell engine calls as `$.noun.method(...)`.
6. Draw from `$.ui.resolve(e)` and check optional elements (`'Input' in els`): mobile has no `Input`/`Select`.
7. Write from handlers (`onPress`, events), never inside a `ui.render` hook.
8. Add your mod to `.claude-plugin/marketplace.json` and the README table.
9. Follow the design spec in **[docs/design.md](docs/design.md)** so your mod looks like the rest: copy the kit block verbatim (theme colors, glyphs, pane header, sections, right-aligned numbers, empty states), `variant="primary"` on the one main action, `r` refresh and `c` clear. `npm test` checks that the kit is identical everywhere and that no raw colors or off-spec glyphs slipped in.
10. A mod with a pane gets `tests/surfaces.test.tsx` (copy one), which draws the pane on every surface at narrow and wide widths.
11. Bump your mod's own `version` in `plugin.json` (patch for fixes and polish) so `/mods` offers the update.

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
claude plugin test plugins/<your-mod>
```
```bash
claude plugin validate .
```

Then try it live: `claude --plugin-dir plugins/<your-mod>`.

Good mods: solve one annoyance, cost zero tokens unless clearly worth it, never surprise the user (ask before changing prompts or blocking work), and say honestly what they can't do.
