# Contributing

Thanks for helping. A few things keep the box working as one plugin.

## Setup

- Node.js 26 (`.nvmrc`) and Claude Code 2.1.287 or newer.
- Load the box from your clone: in `~/.claude/settings.json`, under `env`, set `CLAUDE_CODE_PLUGIN_DIRS` to the clone and `CLAUDE_CODE_PLUGIN_DIR_WATCH` to `1`, restart Claude once. Saved changes then reload by themselves.
- Uninstall a marketplace copy of the box first (`claude plugin uninstall mod-box@mod-box`), so it does not run twice.

## The rules of the box

- `box.json` is the single source of truth. `node tools/box.mjs build` generates `hooks/register.ts`, the type contracts, the `userConfig` in `.claude-plugin/plugin.json` and the window's catalog. Never edit those by hand; CI fails if they are out of date.
- All mods share one plugin, so an event may be registered only once without a matcher: always pass a matcher object (`{}` if nothing narrower).
- `$` must not be passed to functions in other files. State keys are literal (`{ plugin: 'mod-box', key: 'xx_name' } as const`) and declared in the mod's self-contained `types/contract.d.ts`.
- Person-facing texts exist in English and German (`t(de, en)`, `_de` fields in `box.json`). Everything addressed to Claude is English. Code comments are English.

## Adding a mod

Ask Claude: *"add the mod from owner/repo to the Mod Box"*. The bundled skill `skills/mod-box-add/SKILL.md` describes every step: inspection and verdict, license check, import or native install, classification, texts, the "Modified for mod-box" notice, credits, tests. What the box can integrate and what it manages natively is in `docs/capabilities.md`. Doing it by hand, follow the same steps.

## Standalone plugins

[claude-mods](https://github.com/LupusMalusDeviant/claude-mods) is generated from this repo: `node tools/box.mjs export --out <claude-mods clone>`, then commit and push it there. Change mods here, not there.

## Before a pull request

```bash
node tools/box.mjs build
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
node --test tools/box.test.mjs
```

```bash
node --test tools/lifecycle.test.mjs tools/native.test.mjs
```
