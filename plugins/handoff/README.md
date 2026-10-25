# Handoff Note

/handoff writes a handoff note to .claude/handoff.local.md; a new session offers to continue from it.

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install handoff --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install handoff@mod-box
```

## Hooks into

`SessionStart`

## Commands

| Command | What it does |
|---|---|
| `/handoff` | write the handoff note |

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `auto` | `off` | on: written by itself shortly before the cache goes cold (when the context is large). |
| `language` | `en` | Language of the texts this mod shows and writes. |
| `ttlMinutes` | `60` | 60 on a subscription (Pro/Max), 5 for the API's default cache. |

## Token cost

one request over the warm cache per note

## License

MIT, see [LICENSE](LICENSE).
