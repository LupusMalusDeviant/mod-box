# Desktop Pet

A desktop pet and little companion on the Windows desktop, always on top and in front of borderless games: a cardboard box or one of twelve figures (cat, dog, fox, bunny, hamster, owl, penguin, frog, axolotl, dragon, robot, ghost; cat, dog and bunny in nine coats). It says in a speech bubble what Claude is doing and sums up each answer; Claude's questions, Next Steps' suggestions and reply options are buttons in the bubble, and with typing on a hotkey opens a box to answer without leaving the game. A click on the pet shows the last answer in short; an unanswered bubble shrinks to one line. Optionally one pet per active session, each with its own figure and a name tag, asleep while its prompt cache is cold; it warns before the cache goes cold, and its menu keeps the cache warm (1 h, 3 h, always, off). Other mods at the pet: a command Blast Radius holds, a task from Human in the Loop (done or an option with one click) and the CI Watch result come up in the bubble, and stand in short beside its name. Built once with the C# compiler that ships with Windows and signed when a signing script is there. /pet shows it, /pet cat calico picks a figure, /pet stop sends it off.

Part of the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), which bundles it with other mods and one window to switch and configure them all. This is the same mod on its own.

## Install

In a terminal Claude Code session (2.1.287 or newer):

```
/plugin install pet --marketplace LupusMalusDeviant/mod-box
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/mod-box
claude plugin install pet@mod-box
```

## Hooks into

`PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`

## Works with

Desktop Pet needs no other mod. These add to it when installed beside it:

| Mod | What it adds | Without it |
|---|---|---|
| [Cache Meter](https://github.com/LupusMalusDeviant/mod-box/tree/main/plugins/cache-meter) or [Cache Tax](https://github.com/karanb192/cache-tax) | a **Keep warm (1 h)** button in the warning before the prompt cache goes cold (`/keepwarm`) | the warning comes without the button |
| [Next Steps](https://github.com/hamzafer/claude-code-mods/tree/main/mods/next-steps) | its suggestions for the next step as buttons in the bubble | no next-step suggestions; a closing question still gets reply buttons (Haiku) |
| the `sign-binary` skill or [Sign Guard](https://github.com/LupusMalusDeviant/mod-box/tree/main/plugins/sign-guard) | signs the pet's program after it is built (option `signScript`) | the pet runs unsigned |

## Commands

| Command | What it does |
|---|---|
| `/pet` | show the desktop pet |
| `/pet <figure> [coat]` | pick a figure, e.g. /pet cat calico |
| `/pet stop` | send it off |

## Options

Set them in `/config` (or when installing).

| Option | Default | What it does |
|---|---|---|
| `bubble` | `9` | How long news stays in the bubble. Questions and errors stay until the next news. |
| `summary` | `off` | off: the first sentences of the answer (no tokens). haiku: Haiku sums up a longer answer in up to three short sentences (what was done, what is open). A click on the pet shows the last answer in short either way. |
| `kind` | `box` | Who stands on the desktop. random: a different one each session. /pet cat calico switches it too. |
| `fur` | `auto` | The coat colour of cat, dog and bunny. |
| `perSession` | `off` | on: every session whose prompt cache is warm has its own pet, side by side, each with its own figure (/pet or the right-click menu). When a session's cache goes cold its pet goes to sleep; the next message brings it back. off: one pet for all. |
| `cacheWarn` | `5` | That many minutes before the prompt cache expires the pet says so, with a button that keeps it warm for an hour (Cache Meter on). Not while keep-warm runs. |
| `ask` | `on` | Claude's questions (AskUserQuestion) appear as buttons in the bubble too; the first answer counts, the pet's or the dialog's. |
| `remind` | `60` | A question still open whose bubble you hid (double-click, menu) comes back after that many seconds. Not while the pet is snoozed. |
| `suggest` | `on` | With Next Steps on, its suggestions appear as buttons in the bubble. When an answer ends with a question to you, Haiku offers two or three short replies as buttons (a few tokens). A click sends one as your next prompt. |
| `permissions` | `show` | show: the pet only says that Claude Code is waiting for your approval. answer: the bubble also offers "allow once" and "deny" for 90 seconds (never "always"; no rule is added); a command Blast Radius holds gets "Proceed" and "Cancel" too. Mind that the pet stays on top: a click there approves. |
| `typing` | `off` | on: a hotkey, the pet's menu or a button in the bubble opens a small input box; the text goes to Claude as the next prompt, as the answer to its open question, or in place of a suggestion. Typing takes the keyboard from the game for a moment (borderless windowed mode is fine). Any program of your user can write the pet's answer file, hence off by default. |
| `hotkey` | `ctrl+alt+space` | Opens the input box from anywhere, also from a game. With several pets the first one gets it. |
| `language` | `en` | Language of the texts this mod shows and writes. |
| `signScript` | `` | PowerShell script called as <script> -Exe <file>. Empty: ~/.claude/skills/sign-binary/sign.ps1 |
| `cacheTtl` | `60` | 60 on a subscription (Pro/Max), 5 for the API's default cache. |

## License

MIT, see [LICENSE](LICENSE).
