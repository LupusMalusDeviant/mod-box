# Blast Radius

Holds risky shell commands (rm -rf, git reset --hard, git clean, force push, migrations) and shows what they would hit.

> **Fork.** Based on [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius) by Anthropic PBC (Apache-2.0); modified for the [Mod Box](https://github.com/LupusMalusDeviant/mod-box): it works on Windows (PowerShell wait loop, Git Bash, Windows cd targets). Each changed file says so at the top.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install blast-radius --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install blast-radius@mod-box
```

## Hooks into

`PreToolUse`, `PostToolUse`

## License

Apache-2.0, see [LICENSE](LICENSE).
