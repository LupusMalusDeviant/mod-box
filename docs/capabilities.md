# What the Mod Box can do with a foreign plugin

A Claude Code plugin can bring many kinds of parts. The box handles each one in one of three ways:

- **integrated**: copied into the box. It sits behind a box switch, follows profiles and the band, and gets its options from the box. This works only where nothing is lost on the way.
- **native**: the plugin stays a plugin of its own and Claude Code loads it. The box drives Claude Code's own plugin commands (`claude plugin install | enable | disable | configure | update | uninstall | details`) and shows the plugin in the same window, with the same trust and profile rules.
- **not supported**: the box can neither integrate nor manage it. It says why, and changes nothing.

`node tools/box.mjs inspect --dir <folder>` (or `--url <repo>`) gives the verdict. It only reads the files and runs none of the plugin's code. The **Sources** tab shows the same verdict.

## Matrix: before and after

"Before" is the state at v0.4.1, checked with the fixtures in `tools/fixtures/plugins` (`tools/lifecycle.test.mjs`; 4 of its first 24 cases passed against v0.4.1). "After" is this branch.

| Part of a plugin | Before (v0.4.1) | After |
|---|---|---|
| One function-hook module (`hooks/hooks.json` → `modules`) | integrated | **integrated** |
| Several hook modules | only the first was loaded; the rest were dropped **without a word** | **integrated**, all modules behind one switch |
| Files outside `hooks/` (media, docs, data) | not copied; paths broke | **integrated**, copied, `asset:` and `$.plugin.root` paths rewritten |
| Literal `$.store` keys | shared with every other mod (clashes) | **integrated**, prefixed per mod |
| Options of type number, boolean, list | turned into strings | **integrated**, types kept |
| Required options without a default | made the whole box fail to load | **integrated**; the switch and the profiles wait until the option is set |
| Sensitive options (API keys) | ended up in box `userConfig` as plain text | **native**: Claude Code keeps them in its credential store; the box shows only *set / not set* |
| Skills, slash-command files, agents | silently dropped | **native** |
| MCP servers, LSP servers | MCP dropped, LSP refused | **native** |
| Classic hooks (shell commands in `hooks.json`) | refused, no way forward | **native** |
| `dependencies` on other plugins | ignored | **native** (Claude Code installs them) |
| `${CLAUDE_PLUGIN_ROOT}` / `${CLAUDE_PLUGIN_DATA}` | broke | **native** |
| A command or tool name already taken by another mod | let through (two mods answered `/ci`) | **blocked** for integration; native still possible |
| No license | imported anyway | **blocked** for integration unless `--accept-unlicensed`; a license at the top of a collection repo counts |
| Updates of a mod imported from a plain folder | impossible (needed a git remote) | content hash as version, diff and three-way merge |
| Binary files in an update | not handled | compared by hash, copied whole, or a conflict if changed here |
| A failed import or update | rolled back | rolled back (unchanged, now tested) |
| Plugin from a marketplace (`name@market`) | not possible | **native**: install, details, options, enable/disable, update with diff, uninstall |
| Plugin repo or folder without a marketplace | not possible | **native** through the box's own local marketplace `mod-box-local` |
| A plugin you installed yourself | invisible to the box | **native** after *adopt* |
| Marketplace that runs a command to fetch the plugin | – | **native**, but the box shows the command and its SHA-256 and waits for your OK |
| Foreign code not trusted yet | imported mods: off until trusted | the same for integrated *and* native: installed off, profiles skip it, no switching on before *Trust* |
| Profiles and mods added later | integrated mods: by rule | integrated **and** native: by the same rule (`group`, `tokens`) |

### Still not supported

- A plugin whose hook module is missing or does not parse (`hooks.json` names a file that is not there).
- A folder that is neither a plugin (`.claude-plugin/plugin.json` or `hooks/`) nor a marketplace.

## Two strategies

The setting **Import strategy** (`importStrategy` in `box.json`, also in the window) chooses:

- **auto** (default): plain function-hook mods are integrated, everything else is managed natively.
- **native**: every plugin is managed natively; the box only switches, configures, updates and removes it.

Both are built and tested. Which one becomes the default is still to be decided.

## Security

- **Off by default.** Every foreign plugin, integrated or native, starts switched off. Profiles skip it until you press **Trust**. Trust is a decision, not a sandbox: once trusted, the code runs with the rights of any plugin.
- **Nothing runs when you look.** `inspect`, the Sources tab and the parts list read files only.
- **Secrets never leave the credential store.** The box writes sensitive values only through stdin to `claude plugin configure --values-stdin` and never reads them back. The window shows only *set / not set*; a test checks that a secret never shows up in any output.
- **Validation is not an audit.** `claude plugin validate` and the box's checks prove that a plugin loads, not that it is harmless. Read foreign code before you trust it.
- **No blind overwrites.** The box writes only documented settings (`pluginConfigs`, `autoCompactWindow` on request). Native plugins are changed only through `claude plugin …`.

## Platform limits

- **One hooks module per plugin** in Claude Code itself. A plugin that names two is refused by Claude Code, so it cannot run natively; the box can integrate it.
- **Changes need a reload.** Enabling, disabling, installing or updating a native plugin takes effect after `/reload-plugins` or a restart. `/reload-plugins` is not available over a remote connection.
- **No masked input** in the window (the `Input` element has none). So secrets are not typed into the window: it copies `/plugin configure <id>` for you.
- **`claude plugin details` does not count function-hook modules**, so a native mod made only of hooks shows 0 parts there; the box shows its own inventory next to it.
- **Type errors in foreign code** are not fixed by the box. A mod that does not type-check against the current Claude Code types (seen in `md-preview` and `agent-radar`) still loads, because Claude Code strips the types. Such a mod is imported anyway; check it if it misbehaves.
- **A native install needs a marketplace.** The box solves this with its local marketplace `mod-box-local` under `$MODBOX_HOME/local-market`.

## Tested with real plugins

| Source | Plugin | Verdict | What was run |
|---|---|---|---|
| hamzafer/claude-code-mods | 21 mods | integrate | inspect; token-weather, context-bar, glance, md-preview, agent-radar, session-saver, prayer-times, snake imported into a sandbox copy of the box: validate passes, 53/53 plugin tests |
| hamzafer/claude-code-mods | switchboard, openai-balance | native (API keys) | switchboard in an isolated profile: native install via `mod-box-local`, off and untrusted after install, switching on refused before trust, three secrets shown as `null`, trust → enable → disable, uninstall |
| anthropics/claude-plugins-official | commit-commands | native (skills) | isolated profile: install with `--source`, details (3 skills, 71 tokens always on), update (no change, empty diff), uninstall |
| anthropics/claude-plugins-official | 315 entries | 39 native (local), 276 remote | inspect through the catalog |
| JohnnyVizz/claude-kit | savvy-flow / savvy-progress | native / integrate | inspect |
| karanb192/cache-tax | cache-tax | blocked (`/keepwarm` taken by cache-meter) | inspect |
| anthropics/claude-code-playground | 3 mods | integrate (Apache-2.0 from the repo root) | inspect |
