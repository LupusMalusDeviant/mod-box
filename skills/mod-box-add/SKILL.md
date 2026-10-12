---
name: mod-box-add
description: Add any Claude Code plugin or mod to the Mod Box — integrated into the box or managed natively through it — or re-classify one that is already there. Use when the person asks to add, import, integrate, install or "build in" a mod or plugin through the Mod Box, names a git repo, folder or marketplace entry for that, or asks to fix how a box mod is grouped, which profiles include it, or where it runs.
---

# Adding a plugin to the Mod Box

The Mod Box is one plugin that carries many mods, each behind its own switch, and it also manages other plugins that stay plugins of their own. `box.json` is the single source of truth for the box's own mods: every generated file (`hooks/register.ts`, the type contracts, the `userConfig` in `.claude-plugin/plugin.json`, the window's catalog) comes from it through `node tools/box.mjs build`. Never edit generated files by hand.

There are three outcomes for a plugin, and the person should always hear which one applies:

- **integrated**: copied into the box (plain function-hook mods, where nothing gets lost).
- **managed natively**: stays its own plugin; the box installs, switches, configures, updates and removes it through `claude plugin …`.
- **not supported**: neither works; say why.

`docs/capabilities.md` lists which parts of a plugin lead to which outcome.

## Language

- Everything written for Claude (this skill, prompts, comments, commit messages) is English.
- Talk to the person in the Mod Box language: the `language` option (`en` or `de`) in `pluginConfigs` of `~/.claude/settings.json` (key `mod-box@…`); if it is not set, English. If the person writes in another language, follow them.
- Every person-facing text in `box.json` exists twice: `title` / `title_de`, `description` / `description_de`, `costs` / `costs_de`, option titles and descriptions, and `en` / `de` for commands and value labels. Write both.

## Steps

1. **Find the folder.** The box lives where the person keeps it. If it is not the working directory, find it with `claude plugin list` (the `mod-box@…` entry and its path) and work there.

2. **Inspect first.** Run `node tools/box.mjs inspect --url <owner/repo or URL> [--plugin <name>]` (or `--dir <folder>`). It reads the files only and runs nothing. Its answer has, per plugin, a `verdict` (`integrate`, `native`, `blocked`, `unsupported`), the `reasons`, the `components` and the license. Tell the person the verdict and the reasons in a few lines before you change anything.
   The box setting `importStrategy` decides: `auto` integrates what can be integrated and manages the rest natively; `native` manages everything natively.

3. **Check the license.** For integration it must allow copying and changing (MIT, Apache-2.0, BSD, ISC, MPL and the like). A license at the top of a collection repo counts. With none, stop and ask; `--accept-unlicensed` only on the person's explicit word. For a native install the plugin is not copied into the box, but still say what license it has.

4. **Verdict `integrate`: import.** Run `node tools/box.mjs import --url <…> [--plugin <name>]` (or `--dir`). The tool copies the mod into `mods/<id>/` with all its hook modules and files, rewrites it for the box (state keys under a prefix, literal `$.store` keys prefixed, `{}` matchers, `$.plugin.root` and `asset:` paths, `mcp__` tool names), keeps option types, adds it to `box.json` switched off, builds, validates and rolls back on failure. Its answer includes a line starting with "Classification (guess)": a first guess from the code, not a decision.
   If the import fails or reports `lost` files, report it and stop. Do not patch around a failed validation without telling the person.
   Then continue with steps 5–9.

5. **Read the mod and classify it.** Open its hooks module(s) and decide each attribute of its entry in `box.json`. Where you differ from the guess, say why in one line.
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

6. **Mark it as modified.** Every file of the mod that now differs from its original gets a notice right below its license header (after an `SPDX-License-Identifier` line, else at the top):
   ```
   // Modified for mod-box (https://github.com/LupusMalusDeviant/mod-box): <what changed>.
   // Original: <repo URL> (commit <short sha>).
   ```
   The original commit is in `mods/<id>/upstream.json`. Keep the mod's own `LICENSE` file in its folder.

7. **Credit it.** Add a row to the Credits table in `README.md` (mod, linked original, author, license, what changed in the box), and a row to the mods table and, if it has commands, to the Commands table.

8. **Test.** Run from the box folder, and do not report success unless all pass:
   - `node tools/box.mjs build`
   - `claude plugin validate .`
   - `claude plugin test .` — add one small test in `tests/` for the new mod's main behaviour when it has one you can drive (a guard that refuses, a command that answers).
   - `node --test tools/box.test.mjs`
   Type errors that come from the foreign code itself (not from the box) do not stop it from loading; mention them, do not rewrite the mod to fix them unless asked.

9. **Report** to the person, in their language: that it is **integrated**, where it was put (group), whether it costs tokens, where it runs and what it needs, its commands, and which profiles switch it on. Say that it starts switched off and that profiles leave foreign code off until they trust it (the Trust button under ⚙, or switching it on by hand).

10. **Verdict `native`: install through the box.** Run one of:
    - `node tools/box.mjs native install <name>@<marketplace>` for a marketplace entry Claude Code already knows,
    - `node tools/box.mjs native install <name> --source <owner/repo or URL>` to add the marketplace on the way,
    - `node tools/box.mjs native install [<name>] --url <repo>` or `--dir <folder>` for a plugin without a marketplace (it goes through the box's local marketplace `mod-box-local`).
    If the answer has `confirm` (a marketplace that runs a command to fetch the plugin), show the person the command and its SHA-256 and only re-run with `--accept-command <sha256>` after they agree.
    The plugin is installed **switched off and untrusted**. Then show `node tools/box.mjs native details <id>` (its parts and their token cost) and `native options <id>`.
    - Sensitive options are never typed into the chat or the window. Tell the person to set them with `/plugin configure <id>`; the box shows only whether they are set.
    - Other options: `node tools/box.mjs native set <id>` with the values as JSON on stdin.
    Report: **managed natively**, why (the reasons from inspect), its parts and cost, that it is off until they trust it (Trust in the window, or `native trust <id>`), and that changes take effect after `/reload-plugins` or a restart.
    A plugin the person installed themselves comes under the box with `node tools/box.mjs native adopt <id>`.

11. **Verdict `blocked` or `unsupported`.** Change nothing. Say what blocks it (a command name already taken, no license, a missing hook module) and what would solve it — for a clash, the native way (Claude Code then loads both; only switch on the one whose command you want), or removing the box mod that holds the name first.

## How profiles treat a new mod

Profiles in `box.json` are rules, not lists: `"defaults"` (each mod's own `default`), `"all"`, or an object of attribute lists that must all match, such as `{ "group": ["guards"] }` or `{ "tokens": ["none", "optional"] }`. A new mod is judged by the same rule, so classifying it correctly is what puts it into the right profiles. Natively managed plugins carry the same attributes in the box's registry and follow the same rules once trusted. The window remembers the profile last applied; at the next session start it gives each new mod the switch that profile wants. Foreign mods stay off until trusted, and a mod with an empty required option stays off until it is set.

## Do not

- Do not edit generated files, `.secretguard-allow`, or the person's settings beyond what they asked.
- Do not integrate a mod whose license you could not confirm.
- Do not print, log or echo the value of a sensitive option, and do not ask the person to paste one into the chat.
- Do not trust or switch on foreign code yourself; that is the person's decision.
- Do not commit or push unless the person asks.
