# Cache Meter

Band: time left on the warm cache, hit rate, context as weather with its trend over 12 turns, plan limits, compact and keep-warm buttons; stops one send to a cold cache and names its cost (Cache Tax runs inside).

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

> **Contains a fork.** The cold-send guard and keep-warm are [Cache Tax](https://github.com/karanb192/cache-tax) by Karan Bansal (MIT), embedded and modified (guard and auto-warm options, a compact-first hint, token usage); see `mods/cache-tax/` and its LICENSE.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install cache-meter --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install cache-meter@mod-box
```

## Hooks into

`UserPromptSubmit`, `Stop`, `SessionStart`, `PreCompact`

## Commands

| Command | What it does |
|---|---|
| `/keepwarm <6h\|90m\|always\|off\|status>` | keep the cache warm |
| `/cache-tax` | cache costs of this session |

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `ttlMinutes` | `60` | 60 on a subscription (Pro/Max), 5 for the API's default cache. |
| `limits` | `on` | Usage of the 5-hour and the weekly window. |
| `guard` | `refuse` | refuse: stop one send to a cold cache with a large context and name the cost (send again to pay). warn: only show the cost. off. |
| `keepWarmHours` | `3` | How long the keep-warm button keeps the cache warm (one small request over the cache about every 50 minutes of idle). |
| `autoWarm` | `off` | on: after a paid cold write, keep the cache warm for 3 hours by itself (costs tokens). |
| `autoCompact` | `auto` | Sets Claude Code's autoCompactWindow. On 1M-context models Claude only compacts by itself at about 967k tokens, and every turn re-reads the whole context until then. auto = Claude's default. |
| `language` | `en` | Language of the texts this mod shows and writes. |

## Token cost

keep-warm requests, only when switched on

## License

MIT, see [LICENSE](LICENSE).
