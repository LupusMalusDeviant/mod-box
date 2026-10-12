# codebase-map

A Claude Code plugin that writes feature-level blueprints of a codebase and shows them as a live map inside Claude Code.

Claude slices a repository read-only into features and writes one Markdown file per feature plus an index into `docs/blueprints/`. The index holds a path mapping (which files belong to which feature) and a table of dependencies between features that a script extracts from the code. The plugin draws a map from these files, marks the features Claude is editing, warns when the blueprint falls behind `HEAD`, and can mirror the blueprint into Confluence.

## Contents

- [What you get](#what-you-get)
- [What it is good for](#what-it-is-good-for)
- [Requirements](#requirements)
- [Installation](#installation)
- [Configuration](#configuration)
- [How to use](#how-to-use)
- [Publishing to Confluence](#publishing-to-confluence)
- [What the plugin writes](#what-the-plugin-writes)
- [Limitations](#limitations)
- [Development](#development)
- [License](#license)

## What you get

| Part | What it does |
|---|---|
| **Mapper instructions** (`mapper/INSTRUCTIONS.md`) | The workflow Claude follows to create, update, check or publish a blueprint. It writes `docs/blueprints/INDEX.md` (overview, path mapping, edge table with Mermaid graph, commit stamp) and one file per feature (purpose, central files, dependencies, public interface, data flow). Re-runs diff against the commit stamp and rewrite only stale features. |
| **`mapper/scripts/edges.mjs`** | A Node script without dependencies. It assigns every source file to a feature, extracts the edges between features (build references, type references, interface implementations, HTTP routes) and, with `--check`, reports paths and identifiers in the blueprint that do not exist in the code. |
| **Map pane** (`/codebase-map`) | An interactive map of all features. In the desktop app it is a dependency graph, in the terminal a list. Pick a feature to see its purpose, what it uses, what uses it, and its files. |
| **Live highlighting** | While Claude or a subagent edits a file, the feature that owns it turns orange. Afterwards it stays marked as "changed this session, blueprint may be stale". |
| **Freshness band** | A line above the prompt when the blueprint is behind `HEAD`, for example "Blueprint is 3 commits / 5 files behind HEAD", with buttons to prepare the update prompt or open the map. |
| **`CLAUDE.md` block** | A managed block in the repo's `CLAUDE.md` that tells Claude and its subagents how to use the blueprint: find the target feature through the path mapping, follow the verified edges to the affected features, open only their code. |
| **Confluence mirror** (optional) | Publishes the blueprint as a Confluence page tree through the Atlassian MCP. |

The plugin has no skill. When a prompt contains "blueprint", "blueprints", "Bauplan", "Baupläne", "codebase-map" or "codebase-mapper", a `prompt.submit` hook adds a hint for that one prompt (slash commands excluded) that tells Claude to read `mapper/INSTRUCTIONS.md` first. Other prompts carry nothing from the plugin, so it adds no context tokens outside blueprint work, apart from the `CLAUDE.md` block in repos that have a blueprint.

## What it is good for

Do not expect token savings. Reading the blueprint costs tokens too, and Claude still has to open the code it changes.

The value lies elsewhere:

- **Orientation for people.** The map, the live highlighting and the Confluence mirror show how a codebase splits into features and where Claude is working right now. New team members get a starting point that is versioned with the code.
- **Dependencies checked by a machine.** The edge table comes from `edges.mjs`, not from a model's memory, and every edge carries a `file:line` reference. The `--check` run removes paths and names from the blueprint that do not exist in the code. When Claude asks "what does this change touch", it starts from these edges.

## Requirements

- **Claude Code 2.1.293 or newer.** The map, band, live highlighting and prompt hint use function-hook plugins ("mods"), an early-access API that may change between releases.
- **git** on the `PATH`. The freshness check compares the blueprint's commit stamp with `HEAD`, and `edges.mjs` lists files with `git ls-files`.
- **Node.js** on the `PATH` for `edges.mjs` while a blueprint is generated. Reading a blueprint needs no Node.
- **For Confluence only:** the Atlassian MCP connected in Claude, with write access to the target space.

## Installation

### From the marketplace

The repository is its own marketplace. In a terminal session of Claude Code:

```
/plugin install codebase-map --marketplace LupusMalusDeviant/codebase-map
```

Or from a shell:

```bash
claude plugin marketplace add LupusMalusDeviant/codebase-map
claude plugin install codebase-map@codebase-map
```

Choose user scope to make it available in every project. A plugin installed this way also loads in the Code tab of the desktop app.

### With the Mod Box

If you use the [Mod Box](https://github.com/LupusMalusDeviant/mod-box), import this repository in the Box's Sources tab. The Box then lists codebase-map with its own switch. The Box integrates function-hook mods only, which is why the mapper ships as instructions under `mapper/` and not as a skill.

### For development

Clone the repository and point Claude Code at the folder:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/codebase-map"
  }
}
```

Put this into `~/.claude/settings.json` and restart Claude Code. Separate several folders with `;` on Windows and `:` on macOS and Linux. For a single session: `claude --plugin-dir /path/to/codebase-map`.

### Check that it works

Open a session in a repo and type `/codebase-map`. A pane opens, either with the map or with "No blueprint under docs/blueprints in this project" and a button to create one.

### Upgrading from 0.3

Version 0.3 shipped a skill named `codebase-mapper`. If an older copy of that skill is still installed, for example under `~/.claude/skills/codebase-mapper` or from an earlier plugin, remove it. Otherwise it competes with the hint for the same prompts.

## Configuration

Two options, both shown in Claude Code's config menu:

| Option | Values | Default | Effect |
|---|---|---|---|
| `language` | `de`, `en` | `de` | Language of the map, the band, the prepared prompts and the `CLAUDE.md` block. The block also sets the blueprint's documentation language, so new blueprints, log entries and Confluence titles follow it. |
| `claudeMd` | `auto`, `off` | `auto` | `auto` keeps the block in `CLAUDE.md` up to date in every repo that has a blueprint. `off` never writes `CLAUDE.md` and removes an existing block at the next session start. |

To set them in `~/.claude/settings.json` instead of the menu:

```json
{
  "pluginConfigs": {
    "codebase-map": { "language": "en", "claudeMd": "auto" }
  }
}
```

A plugin loaded with `--plugin-dir` or `CLAUDE_CODE_PLUGIN_DIRS` may be keyed as `codebase-map@inline`; the config menu shows the exact key.

## How to use

### Commands

| Command | Effect |
|---|---|
| `/codebase-map` | Opens the map. |
| `/codebase-map create` | Puts "create a blueprint for this codebase" into the input box. |
| `/codebase-map update` | Puts "update the blueprint" into the input box. |
| `/codebase-map check` | Puts "is the blueprint still up to date?" into the input box. |
| `/codebase-map publish` | Puts the Confluence prompt with a placeholder for the parent page URL into the input box. |

Nothing is sent until you press Enter. With `language` set to `de` the prompts are German.

### First blueprint

Say "create a blueprint for this codebase" (or "erstelle einen Blueprint für diese Codebase"). Claude:

1. asks for the scope (whole repo or a subfolder),
2. proposes a feature list with path globs per feature and waits for your confirmation,
3. runs `edges.mjs` to assign every source file to a feature and extract the edges between features,
4. writes `docs/blueprints/<feature>.md` per feature and `docs/blueprints/INDEX.md`; statements about runtime behaviour carry a `file:line` reference,
5. runs `edges.mjs --check` and fixes every path or identifier that does not exist in the code,
6. logs the run in `docs/SkillUsed/codebase-mapper.md`.

Source code is never modified. Commit the blueprint together with the `CLAUDE.md` block.

### Keeping it fresh

| You say | What happens |
|---|---|
| "is the blueprint up to date?" | Read-only check: which features changed since the stamp, which changed files belong to no feature. |
| "update the blueprint" | Incremental run: only stale features are rewritten. Manual additions in feature files are kept. |
| "update the blueprint for the feature "X"" | Only that feature. |

The band above the prompt tells you when an update is due. Its button "Prepare prompt" fills in the prompt for you.

### The map

- `/codebase-map` or the "Map" button in the band opens it.
- Node colours: **strong orange** means Claude is editing a file of this feature right now, **pale yellow with a dashed border** means a file of this feature changed in this session, **blue** is the selected feature.
- The "Feature" picker shows details for one feature, with buttons to update its blueprint or publish only this feature to Confluence.
- Files that changed but belong to no feature are listed below the map. They are candidates for the next blueprint update.

## Publishing to Confluence

Optional and never automatic. Say "publish the blueprint to Confluence under <URL of the parent page>", use `/codebase-map publish`, or use the buttons in the map ("Publish the whole blueprint" at the top, "Publish only this feature" in a feature's details).

What Claude does:

1. Checks the Atlassian MCP connection and resolves the space from the parent page.
2. **Scans every file for secrets and personal data** (API keys, tokens, e-mail addresses, customer data). Any hit stops the run.
3. Shows a plan (create, update or skip per page) and waits for your confirmation.
4. Creates the index page under your parent page and one child page per feature, then fills them, so links between the pages resolve on the first run.
5. Writes a YAML frontmatter block and a `<!-- confluence-page-id: N -->` comment into each published file. **Commit them**, otherwise the next run creates duplicate pages.

Details:

- **Diagrams:** if your Confluence site has a Mermaid macro app installed (for example the Forge app "Mermaid diagram"), Claude uses it and reads the extension key from an existing page that uses the macro. Otherwise Mermaid blocks are published as code blocks.
- **Titles:** `<Repo>: <Feature>`, because Confluence titles must be unique per space.
- **Edits in Confluence are protected:** every update carries the version message `codebase-mapper sync <commit>`. A page whose latest version was made by someone else is skipped and reported, unless you choose to overwrite it.
- **Pages are never deleted.** A feature that disappears from the blueprint keeps its page and is reported.
- A publishing CLI your team uses can replace the MCP when you ask for it, as long as it reads the same frontmatter and page-id comment and does not rewrite the `./<slug>.md` links in the files.

## What the plugin writes

| File | Written by | When |
|---|---|---|
| `docs/blueprints/INDEX.md`, `docs/blueprints/<feature>.md` | mapper | when you ask for a blueprint or an update |
| `docs/SkillUsed/codebase-mapper.md` | mapper | after every run (log) |
| `CLAUDE.md` (block between `<!-- codebase-map:start -->` and `<!-- codebase-map:end -->`) | plugin | at session start and after turns, only in repos that have `docs/blueprints/INDEX.md`, only when the block is missing or outdated; a toast tells you. Creates `CLAUDE.md` if the repo has none; uses `.claude/CLAUDE.md` if only that exists. With `claudeMd=off` the block is removed instead. |
| Frontmatter and page-id comments in `docs/blueprints/*.md` | mapper | only when publishing to Confluence |

The freshness check ignores `docs/blueprints`, `docs/SkillUsed` and `CLAUDE.md`, so committing the blueprint does not make it look stale.

After a turn the plugin runs git and rereads the blueprint only if the session used Edit, Write, NotebookEdit, Bash or PowerShell since the last check. Otherwise it checks at most every 5 minutes, so a commit made outside Claude can take that long to show in the band.

## Limitations

- **Early-access API.** Function-hook plugins may change between Claude Code releases. If the map, band or hint stops working after an update, the files in `mapper/` still work: ask Claude to read `mapper/INSTRUCTIONS.md`.
- **The hint depends on keywords.** A prompt that asks for a blueprint without one of the trigger words gets no hint. A prompt that uses the word in another sense (a Flask `Blueprint`) gets the hint, and the instructions tell Claude to ignore it.
- **Live highlighting** sees Claude's Edit, Write and NotebookEdit tools. Changes made through shell commands (`sed`, scripts) are not highlighted.
- **Feature assignment** uses the path globs in `INDEX.md` (most specific glob wins), then the file tables of the blueprints. Blueprints without a mapping section fall back to folders: a new file is assigned only if exactly one feature owns its folder.
- **Edge extraction uses regular expressions, not a compiler.** Coverage by language:

  | Language | What `edges.mjs` reads |
  |---|---|
  | C# (`.cs`, plus `.razor`/`.cshtml` for references) | Top-level types that are not private or protected, with their base types and interfaces, `ProjectReference` build edges from `.csproj`/`.fsproj`, ASP.NET routes (controller `[Route]`, `MapGet` and other minimal-API mappings). |
  | TypeScript / JavaScript | Exported declarations only, `implements` on exported classes, `package.json` dependencies on workspace packages, Express-style routes (`app.get`, `router.post`, ...). |
  | Go | Exported types only. No implicit interface implementations, no `go.mod`. |
  | Python | Class declarations and their base classes. |
  | Java | Classes, interfaces, enums and records with `implements`. |
  | Kotlin | Limited: `.kt` files go through the Java patterns, so Kotlin-specific forms (`data class`, `object`, `: Base`) are missed. |
  | Rust, PHP, Ruby, C/C++, Swift | Not read. Files are ignored. |

  The script does not see reflection, dynamically built URLs or calls without a shared type name. An HTTP edge says a feature names a route, not that the code path runs. Without Node, Claude writes a reduced table by hand and marks it as unchecked.
- **Tooltips** on map nodes depend on the surface. If hovering a node shows no dark outline, the surface draws the graph as a static image; use the feature picker instead.
- **The blueprint is a guide, not the truth.** The `CLAUDE.md` block tells Claude to follow the code where the two differ.

## Development

```
.claude-plugin/plugin.json        manifest, options (language, claudeMd)
.claude-plugin/marketplace.json   makes this repo installable as a marketplace
hooks/register.tsx                band, map pane, live highlighting, prompt hint, CLAUDE.md upkeep, /codebase-map
hooks/blueprint.ts                parses INDEX.md and feature files, commit stamp, file-to-feature mapping
hooks/svg.ts                      layered dependency graph as SVG
hooks/claudemd.ts                 the managed CLAUDE.md block (de/en)
hooks/i18n.ts                     visible texts, prepared prompts, MAPPER_TRIGGER and the hint text (de/en)
mapper/INSTRUCTIONS.md            the workflow Claude reads when the hint fires
mapper/references/                templates and reference material for the workflow
mapper/scripts/edges.mjs          edge extraction and blueprint check (Node, no dependencies)
mapper/test-prompts.json          example prompts with the expected outcome
tests/map.test.tsx                plugin tests
types/index.d.ts                  types the plugin exposes (blueprint status, map data)
```

Run the checks from the repository root:

```bash
claude plugin validate .
claude plugin test .
```

To work on the plugin with hot reload, load the clone with `claude --plugin-dir <path>`; saving a file reloads the hooks module.

Issues and pull requests are welcome.

## License

MIT, see [LICENSE](LICENSE).
