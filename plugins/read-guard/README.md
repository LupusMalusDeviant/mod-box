# Read Guard

Holds a whole-file Read (no offset/limit) of a file above the limit, a lockfile, minified code or a source map, and the same via cat, type or Get-Content in the shell; tells Claude the size, a token estimate and a better way (Grep, offset/limit). A second try at the same file goes through, and so does a Read with allow_large. Claude Code itself stops only at about 25,000 tokens.

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install read-guard --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install read-guard@mod-box
```

## Hooks into

`PreToolUse`, `PostToolUse`, `SessionStart`

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `limitKb` | `50` | Files above this size are held when read whole. off: only lockfiles, minified files and source maps. |
| `mode` | `block` | block: hold the first try and tell Claude a better way. warn: only a notice. |
| `shell` | `on` | on: also cat, type and Get-Content of a whole file. |
| `language` | `en` | Language of the texts this mod shows and writes. |

## License

MIT, see [LICENSE](LICENSE).
