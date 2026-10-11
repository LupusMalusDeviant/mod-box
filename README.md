# Mod Box

Thirteen Claude Code mods in **one** plugin. Each one has its own switch, and one window manages them all: you can switch mods on and off, change their options, apply profiles, and import more mods from git repos and marketplaces.

Most of the mods are **adapted copies of other people's mods** (see [Credits](#credits)). The rest were written for this box.

## Install

Type this at the prompt of a terminal Claude Code session (needs Claude Code 2.1.287 or newer; the tools in `tools/` need Node.js 26):

```
/plugin install mod-box --marketplace LupusMalusDeviant/mod-box
```

Answer `y` to add the marketplace, then pick a scope. To try it from a clone without installing it, start Claude Code with `claude --plugin-dir <clone>`.

**Working on the box itself:** have Claude Code load it straight from your clone. In `~/.claude/settings.json`, under `env`, set `CLAUDE_CODE_PLUGIN_DIRS` to the folder and `CLAUDE_CODE_PLUGIN_DIR_WATCH` to `1`, then restart Claude once. After that, every saved change reloads the box by itself. An installed plugin runs from a copy that Claude makes at install time, so it only changes with a new version and a restart.

## The window

**`/mod-box`** opens the window. `/mod-box profiles`, `sources` and `diag` open it on a given tab. The window speaks English by default, or German with the `language` setting.

- **Mods**: the mods as cards, one per group. ● means a mod is on, ○ means off; click a mod to switch it. ⚙ opens its description, its token cost and its options. The window has two columns when it is wide enough.
- **Profiles**: set all switches at once: *Default*, *Lean* (nothing that always costs tokens), *Guards only*, *Everything on*. Profiles are rules, not lists (see [Profiles and new mods](#profiles-and-new-mods)).
- **Sources**: connected Claude marketplaces show up here by themselves, and you can add your own git links (a marketplace, a plugin repo or a collection of mods, as `owner/repo` or a URL). The **Import** button fetches a mod with function hooks, rewrites it for the box and validates it. The imported mod starts switched off, and if validation fails, the box stays as it was. **Updates of the originals** checks the copied mods against their upstream repos (see below).

- **Health**: shows four things:
  - token use of the mods that call a model;
  - hook failures in this session;
  - an environment check (node, git, `gh` signed in, Git Bash, the signing script);
  - a **Validate** button.

  If Claude Code runs with `--debug-file ~/.claude/mod-box/debug.log`, this tab also shows the box's last error lines from that log.

Some hosts, the desktop app among them, don't list a plugin's options in `/config`. There the window builds the rows itself and writes changes to `pluginConfigs` in `~/.claude/settings.json`, which is where Claude Code keeps them.

## The mods

| Switch | Mod | Default | What it does | Costs tokens? |
|---|---|---|---|---|
| `blastRadius` | Blast Radius | on | Holds risky shell commands (`rm -rf`, `git reset --hard`, `git clean`, force push, migrations) and shows what they would hit. | no |
| `secretGuard` | Secret Guard | on | Stops before an API key, token, private key or non-ignored `.env` file gets into a file, `git add` or a commit. Mode *block* or *warn*; exceptions via `/secret-allow`. | no |
| `ciWatch` | CI Watch | on | Follows the GitHub Actions runs after each `git push` (via `gh`) to the end. For an open pull request it watches every check and says whether the PR is ready to merge. When a run turns red, it shows the failed step's log and/or puts an analysis request into the prompt; it can also play a sound. `/ci` shows the state. | no |
| `signGuard` | Sign Guard | off | Spots Windows builds and signs the new `.exe`, `.msi` and `.msix` files with your own script (`<script> -Exe <file>`). Mode *ask* or *auto*. | no |
| `savvyProgress` | Savvy Progress | on | Progress bar and agents panel (`/agents-info`). | no |
| `filetree` | Filetree | on | File tree side pane (`/filetree`) that lights up as Claude reads and writes. | no |
| `replayTheater` | Replay Theater | on | Steps through the last turn's edits (`/replay`). | no |
| `nextSteps` | Next Steps | off | Suggests 2–3 next prompts. | a Haiku call per answer |
| `cacheMeter` | Cache Meter (with Cache Tax) | on | Shows the time left on the warm cache, the hit rate, the context as weather and the plan limits, with compact and keep-warm buttons. It also stops a send to a cold cache once and names its cost. | only keep-warm requests, when on |
| `handoff` | Handoff Note | on | `/handoff` writes `.claude/handoff.local.md`, and a new session offers to continue from it. | one request over the warm cache |
| `visibleCompact` | Visible Compact | on | Before/after view of `/compact` (`/show-last-compact`). | no |
| `headsUp` | Heads-up | off | Points out one easily missed but important thing in a long answer. | a Haiku call per long answer |
| `catchMeUp` | Catch Me Up | off | Live summary of the session (`/catch-me-up`). | Haiku calls after turns |

## Commands

| Command | Mod | What it does |
|---|---|---|
| `/mod-box [profiles|sources|diag]` | Mod Box | opens the window, optionally on a tab |
| `/secret-allow` | Secret Guard | the exception list: last finds, project and global entries |
| `/ci` · `/ci pr <nr|url>` · `/ci stop` | CI Watch | state of the watched runs · watch a pull request · stop watching |
| `/agents-info` | Savvy Progress | agents panel |
| `/filetree` | Filetree | opens the file tree |
| `/replay` | Replay Theater | steps through the last turn's edits |
| `/keepwarm <6h|90m|always|off|status>` · `/cache-tax` | Cache Meter | keeps the cache warm · cache costs of this session |
| `/handoff` | Handoff Note | writes the handoff note |
| `/show-last-compact` | Visible Compact | before/after of the last `/compact` |
| `/catch-me-up` | Catch Me Up | live summary pane |

The window lists them too: next to each mod's name, and in full under ⚙.

## The band above the prompt

CI Watch, Sign Guard, Cache Meter, Handoff Note and Heads-up hand their displays to the box, which draws them all in one band above the prompt:

- **Band layout** *compact* puts calm displays on one shared line, and urgent ones (red CI, a sign offer, a heads-up) on lines of their own. *lines* gives each display its own line.
- **Display**, per mod, chooses band, status line or off.
- **Order** is set with arrows in the Mods tab.

## Profiles and new mods

Each mod in `box.json` carries attributes: `group` (guards, display, context, watchers), `tokens` (none, optional, always), `default`, and `compat` (see below). A profile is a rule over them: *Default* takes each mod's `default`, *Lean* takes `tokens: none | optional`, *Guards only* takes `group: guards`, *Everything on* takes all. So a new mod lands in the right profiles as soon as it is classified.

The window remembers the profile you applied last (*Default* until you apply one). At the next session start it gives every mod that is new since then the switch that profile wants, and marks it **new**. If you have changed switches by hand since, the header says *(changed)*; new mods still follow the profile.

**Foreign code waits for trust.** A mod imported from another repo starts switched off, and profiles leave it off until you trust it: **Trust** under its ⚙, or switch it on by hand once. Imported mods show 🔒 until then, 📦 after.

## Where a mod runs

Each mod declares where it works: the surfaces (terminal, desktop app, VS Code, mobile), the operating systems, and the programs it needs (`git`, `gh` signed in, Node.js, Git Bash, PowerShell, a signing script). The window compares that with the session you are in (surface, OS, and the environment check under **Health**) and puts a ⚠ with the reason next to a mod that would not, or not fully, run here. ⚙ shows the full list.

## Adding mods with Claude

The box ships the skill **mod-box-add**. Ask Claude something like *"add the mod from owner/repo to the Mod Box"*, and it:

- checks the license;
- imports the mod with `tools/box.mjs import`;
- reads the code and classifies it: group, tokens, where it runs, what it needs, its commands (`tools/box.mjs analyze <id>` gives a first guess to start from);
- writes the texts in English and German;
- marks the changed files and adds the credits;
- runs build, validation and tests;
- reports back in the language set in the box.

All instructions the box gives Claude (the skill, the prompts of the mods) are English. Only the language Claude answers in follows the setting.

## How the box is built

- **`box.json`** is the single source: mods, switches, options (English, with `_de` translations), groups, state prefixes and profiles.
- **`node tools/box.mjs build`** generates `hooks/register.ts`, the type contracts, the `userConfig` in `.claude-plugin/plugin.json` and the window's catalog. Don't edit those by hand.
- **`tools/box.mjs`** also has `catalog`, `import`, `analyze <id|dir>`, `remove`, `validate`, `updates`, `diff <id>`, `update <id>` and `release` (build, validate, raise the version). The window calls exactly these.

An imported mod is rewritten so the box can drive it like the others:

- its `$.state` keys move under `mod-box` with a prefix;
- each hook without a matcher gets `{}`, because a plugin may register an event only once without one;
- `$.plugin.root` paths point into `mods/<id>/`;
- `mcp__<old>__` tool names become `mcp__mod-box__`;
- its options become box options.

After that, `claude plugin validate` runs, and a failure rolls everything back.

### Updates of the originals

Each copied mod keeps a baseline in `mods/<id>/upstream.json`: the original repo, the commit our copy is based on, and the original files at that commit. **Check for updates** fetches the originals and compares them. **Apply** merges the changes in three ways per file (baseline, new original, our version) with `git merge-file`. The box's own rewrites are applied to both originals first, so they never count as a difference. If both sides changed the same lines, nothing is changed.

## Checking

```bash
node tools/box.mjs build
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

```bash
node --test tools/box.test.mjs
```

## Credits

These mods come from other repositories and **were modified for the Mod Box**. Each modified file carries a notice at the top that names the change and the original commit, and each mod keeps its original `LICENSE` in its folder.

| Mod | Original | Author | License | Changes in the box |
|---|---|---|---|---|
| Blast Radius | [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius) | Anthropic PBC | Apache-2.0 | Windows support (PowerShell wait loop, Git Bash, Windows `cd` targets); state, matchers and paths rewritten |
| Replay Theater | [anthropics/claude-code-playground](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/replay-theater) | Anthropic PBC | Apache-2.0 | state, matchers and paths rewritten |
| Cache Tax | [karanb192/cache-tax](https://github.com/karanb192/cache-tax) | Karan Bansal | MIT | embedded into Cache Meter (guard and auto-warm options, exported helpers, token usage) |
| Catch Me Up | [oliverow/catch-me-up](https://github.com/oliverow/catch-me-up) | Oliver Wang | MIT | language option, token usage, state rewritten |
| Filetree | [data-goblin/claude-code-filetree](https://github.com/data-goblin/claude-code-filetree) | Kurt Buhler | MIT | state, matchers and paths rewritten |
| Next Steps | [hamzafer/claude-code-mods](https://github.com/hamzafer/claude-code-mods/tree/main/mods/next-steps) | Hamza Zafar | MIT | language option, token usage, state rewritten |
| Savvy Progress | [JohnnyVizz/claude-kit](https://github.com/JohnnyVizz/claude-kit/tree/main/plugins/savvy-progress) | johnnyvizz | MIT | a type fix; state and tool names rewritten |
| Visible Compact | [nvsravank/visible-compact](https://github.com/nvsravank/visible-compact) | nvsravank | MIT | state, matchers and paths rewritten |

**Heads-up** is a re-implementation inspired by "You Should Know", which ships with Claude Code (`/plugin enable cc-plugin-you-should-know@builtin`). **Cache Meter, Secret Guard, CI Watch, Sign Guard, Handoff Note**, the window and the tools were written for this box.

## License

The box's own code is under the [MIT License](LICENSE). The copied mods keep their own licenses (MIT or Apache-2.0), in `mods/<id>/LICENSE`.
