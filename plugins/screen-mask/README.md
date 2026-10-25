# Screen Mask

For screen sharing and recordings: hides API keys, tokens, private keys, e-mail addresses, IP addresses, your login name in paths and any names you list. Only the display changes; Claude still reads the original. Nothing leaves the machine. /mask switches it.

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install screen-mask --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install screen-mask@mod-box
```

## Hooks into

`SessionStart`

## Commands

| Command | What it does |
|---|---|
| `/mask [on\|off]` | hide secrets and names on screen |

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `terms` | `` | Comma separated, e.g. customer names, project code names, a server name. Case does not matter. |
| `emails` | `on` | Every address becomes [e-mail]. |
| `ips` | `on` | IPv4 addresses except loopback and documentation ranges become [ip]. |
| `language` | `en` | Language of the texts this mod shows and writes. |

## License

MIT, see [LICENSE](LICENSE).
