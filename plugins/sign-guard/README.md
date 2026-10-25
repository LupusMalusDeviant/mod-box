# Sign Guard

Spots Windows builds (cargo --release, dotnet publish, go build, pyinstaller, tauri, electron-builder, msbuild) and signs the new .exe/.msi/.msix with your own signing script.

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install sign-guard --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install sign-guard@mod-box
```

## Hooks into

`PreToolUse`, `PostToolUse`

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `mode` | `ask` | ask: offer a sign button. auto: sign right away. |
| `script` | `` | PowerShell script called as <script> -Exe <file>. Empty: ~/.claude/skills/sign-binary/sign.ps1 |
| `subject` | `` | Files already signed by a certificate whose subject contains this are skipped. Empty: any validly signed file is skipped. |
| `language` | `en` | Language of the texts this mod shows and writes. |

## License

MIT, see [LICENSE](LICENSE).
