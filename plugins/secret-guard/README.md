# Secret Guard

Stops before Claude writes API keys, tokens, private keys or a non-ignored .env into files, git add or commits. Exceptions for test keys and example files: /secret-allow.

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install secret-guard --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install secret-guard@mod-box
```

## Hooks into

`PreToolUse`, `PostToolUse`, `SessionStart`

## Commands

| Command | What it does |
|---|---|
| `/secret-allow` | exceptions: last finds and both allow lists |

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `mode` | `block` | block: refuse the action. warn: only warn and let it through. |
| `placeholders` | `on` | on: values with EXAMPLE, DUMMY, FAKE, PLACEHOLDER, REDACTED, SAMPLE, xxxxxx … are no secret (this covers the AWS documentation keys). |
| `language` | `en` | Language of the texts this mod shows and writes. |

## License

MIT, see [LICENSE](LICENSE).
