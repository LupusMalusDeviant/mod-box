# Changelog

## 0.4.0

- **Subagent Saver** (new): built-in Explore subagents without a model of their own run on Sonnet (or Haiku) instead of inheriting the main model.
- **Cache Meter**: the cold-send guard names the cost of compacting first; new option *auto-compact at* sets Claude Code's `autoCompactWindow`.
- **Compatibility**: every mod declares surfaces, systems and needed tools; the window warns when a mod would not run here. The OS is detected with `uname` where it is not Windows.
- **Profiles are rules** over mod attributes, so new mods join the right profiles; the window remembers the applied profile (*Default* until one is applied) and marks new mods.
- **Trust for foreign code**: imported mods stay off in every profile until trusted.
- **Skill `mod-box-add`**: Claude imports, classifies, credits and tests a new mod.
- `tools/box.mjs analyze <id|dir>`: a first guess at a mod's group, tokens, commands and where it runs.
- Everything addressed to Claude is English; the answer language follows the setting. English is the default UI language.
- CI on GitHub Actions (Ubuntu and Windows).

## 0.2.0

- First public version: thirteen mods in one plugin, the window (`/mod-box`) with Mods, Profiles, Sources and Health, upstream updates with three-way merge, token usage per mod, Secret Guard exceptions, CI Watch for pull requests.
