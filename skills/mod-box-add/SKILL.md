---
name: mod-box-add
description: Add a Claude Code mod (a plugin with function hooks) to the Mod Box, or re-classify one that is already in it. Use when the person asks to add, import, integrate or "build in" a mod into the Mod Box, names a git repo or marketplace entry for that, or asks to fix how a box mod is grouped, which profiles include it, or where it runs. Do not use for installing ordinary plugins (skills, agents, commands only) — those are installed with /plugin.
---

# Adding a mod to the Mod Box

The Mod Box is one plugin that carries many mods, each behind its own switch. `box.json` is the single source of truth: every generated file (`hooks/register.ts`, the type contracts, the `userConfig` in `.claude-plugin/plugin.json`, the window's catalog) comes from it through `node tools/box.mjs build`. Never edit generated files by hand.

## Language

- Everything written for Claude (this skill, prompts, comments, commit messages) is English.
- Talk to the person in the Mod Box language: the `language` option (`en` or `de`) in `pluginConfigs` of `~/.claude/settings.json` (key `mod-box@…`); if it is not set, English. If the person writes in another language, follow them.
- Every person-facing text in `box.json` exists twice: `title` / `title_de`, `description` / `description_de`, `costs` / `costs_de`, option titles and descriptions, and `en` / `de` for commands and value labels. Write both.

## Steps

1. **Find the folder.** The plugin lives where the person keeps it. If it is not the working directory, find it with `claude plugin list` (the `mod-box@…` entry and its path) and work there.

2. **Check the license first.** Read the mod's `LICENSE` (or the `license` in its `plugin.json`). Continue only for a license that allows copying and changing (MIT, Apache-2.0, BSD, ISC, MPL and the like). If there is none or it forbids it, stop and tell the person.

3. **Import.** Run `node tools/box.mjs import --url <owner/repo or URL> [--plugin <name>]`, or `--dir <folder>` for a local copy. The tool copies the mod into `mods/<id>/`, rewrites it for the box (state keys under a prefix, `{}` matchers, `$.plugin.root` paths, `mcp__` tool names), adds it to `box.json` switched off, builds, validates and rolls back on failure. Its JSON answer includes a line starting with "Classification (guess)": that is a first guess from the code, not a decision.
   If the import fails, report the error and stop. Do not patch around a failed validation without telling the person.

4. **Read the mod and classify it.** Open its hooks module(s) and decide each attribute of its entry in `box.json`. Where you differ from the guess, say why in one line.
   - `group`: `guards` (refuses or holds tool calls, prompts or settings), `display` (draws panes, bands or progress), `context` (cache, context window, compaction, handoff), `watchers` (reads answers or runs and points things out). Keep `imported` only if none fits.
   - `tokens`: `none` (never calls a model), `optional` (only on demand or when an option is on), `always` (calls a model as part of its normal work). If not `none`, also write `costs` / `costs_de`: what it costs and when.
   - `compat.surfaces`: where it draws or works: `terminal`, `desktop`, `vscode`, `mobile`. `Raster` and `Image` exist only on the terminal; `Svg` not on the terminal; `Client` not on mobile or VS Code; `Input` and `Select` not on mobile — unless the code checks `e.surface` and falls back.
   - `compat.os`: `windows`, `mac`, `linux`. Narrow it only when the mod truly needs one system (for example PowerShell with no fallback).
   - `compat.needs`: external programs it cannot work without: `git`, `gh`, `node`, `bash`, `powershell`, `signScript`. Leave out what it only uses when available.
   - `commands`: every slash command it registers, as `{ "name": "/cmd <args>", "en": "…", "de": "…" }`.
   - `default`: `false` for a foreign mod unless the person says otherwise.
   - `band`: leave `false`; an imported mod draws its own band.
   - `title`, `description` and their `_de`: short, plain, what the person gets from it.
   Then run `node tools/box.mjs analyze <id>` to compare the guess with what you wrote, and `node tools/box.mjs build`.

5. **Mark it as modified.** Every file of the mod that now differs from its original gets a notice right below its license header (after an `SPDX-License-Identifier` line, else at the top):
   ```
   // Modified for mod-box (https://github.com/LupusMalusDeviant/mod-box): <what changed>.
   // Original: <repo URL> (commit <short sha>).
   ```
   The original commit is in `mods/<id>/upstream.json`. Keep the mod's own `LICENSE` file in its folder.

6. **Credit it.** Add a row to the Credits table in `README.md` (mod, linked original, author, license, what changed in the box), and a row to the mods table and, if it has commands, to the Commands table.

7. **Test.** Run from the plugin folder, and do not report success unless all pass:
   - `node tools/box.mjs build`
   - `claude plugin validate .`
   - `claude plugin test .` — add one small test in `tests/` for the new mod's main behaviour when it has one you can drive (a guard that refuses, a command that answers).
   - `node --test tools/box.test.mjs`

8. **Report** to the person, in their language: where the mod was put (group), whether it costs tokens, where it runs and what it needs, its commands, and which profiles switch it on. Say that it starts switched off and that profiles leave foreign code off until they trust it (the Trust button under ⚙, or switching it on by hand).

## How profiles treat a new mod

Profiles in `box.json` are rules, not lists: `"defaults"` (each mod's own `default`), `"all"`, or an object of attribute lists that must all match, such as `{ "group": ["guards"] }` or `{ "tokens": ["none", "optional"] }`. A new mod is judged by the same rule, so classifying it correctly is what puts it into the right profiles. The window remembers the profile last applied; at the next session start it gives each new mod the switch that profile wants. Imported mods stay off until trusted.

## Do not

- Do not edit generated files, `.secretguard-allow`, or the person's settings beyond what they asked.
- Do not import a mod whose license you could not confirm.
- Do not commit or push unless the person asks.
