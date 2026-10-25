# Package Guard

Before Claude installs or runs a package (npm, pnpm, yarn, bun, npx, pip, uv, poetry, pipx, cargo), asks the public registry about it. Holds the command when the package does not exist (a made-up name), is under 14 days old, or looks like a well-known package and is young or thin (typosquatting). Allow in the band or with /pkg-allow.

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install package-guard --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install package-guard@mod-box
```

## Hooks into

`PreToolUse`, `PostToolUse`, `SessionStart`

## Commands

| Command | What it does |
|---|---|
| `/pkg-allow [name]` | allow a held package |

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `mode` | `block` | block: hold the command until the package is allowed. warn: only warn and let it through. |
| `language` | `en` | Language of the texts this mod shows and writes. |

## License

MIT, see [LICENSE](LICENSE).
