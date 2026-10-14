# Changelog

## 0.6.3

- **Desktop Pet**: a bubble with a question or buttons that nobody answers shrinks to one line above the pet after the bubble time, or at once with the new – in its corner (its title, how many buttons wait, ▴). A click on it or the pet opens it again; while the pointer is on the bubble it stays big.

## 0.6.2

- **Desktop Pet**: a click on the pet shows Claude's last answer in short (its gist and closing question, or the Haiku summary), with its suggestion or reply buttons while they still apply, ready to answer with ✎ or the hotkey. The click never reached the pet before (the window drag swallowed it).
- **Desktop Pet**: the Haiku summary takes up to three short sentences (what was done, what is open); the window is taller so a summary fits above three buttons, and saved positions keep the pets where they are.

## 0.6.1

- Fix: on Claude Code 2.1.287 the whole box did not load (no /mod-box, no mods), because the window's hooks module declared `home` twice. A tool test now checks every hooks file for this (#19).

## 0.6.0

- **Desktop Pet**, grown from a status box into an overlay you can answer through:
  - 13 figures (box, cat, dog, fox, bunny, hamster, owl, penguin, frog, axolotl, dragon, robot, ghost); cat, dog and bunny in nine coats. Right-click › *Figur* or `/pet <figure> [coat]`.
  - One pet per active session (option), side by side, each with its own figure (kept per session). A pet sleeps when its session's prompt cache goes cold and is back with the next message; a reload or a reopened app no longer wakes the pets of idle sessions.
  - A name tag with the project under every pet.
  - Claude's questions, Next Steps' suggestions and (option) permission requests as buttons in the bubble. An answer that ends with a question shows that question, with two or three short replies from Haiku as buttons. A hidden open question comes back after a while (option).
  - Warns before the prompt cache goes cold, with a button that keeps it warm.
  - Typing (option, off by default): a hotkey, the menu or ✎ opens a small input box; the text goes to the session as the next prompt or as the answer to its open question, and the focus goes back to the game.
  - Rebuilds are signed with the sign-binary skill by default.
- **Screen Mask** (new): for screen sharing and recordings, hides API keys, tokens, e-mail and IP addresses, your login name and names you list in the display; Claude still reads the original.
- **Split Diff**, **Human in the Loop**, **Prompt Rail** (new, from the community): side-by-side diffs, tasks only a person can do, a rail of the session's prompts.
- **Community catalogue**: search awesome-claude-code-mods from the window, see what a mod may read, write, run or send, and import it through the usual checks.
- **Mod reach**: every mod shows what it reads, writes, runs and sends.
- **Cache Meter**: a context trend line. **Codebase Map**: `@feature` in the prompt, no more flicker, follows its repository (0.4.1).
- **Filetree**: stays under the desktop's size limit in large projects.
- CI: a time limit and a second try for installing Claude Code.

## 0.5.0

- **Package Guard** (new): before an install or `npx`/`uvx` run, asks the public registry and holds made-up, brand-new, removed or typosquatted packages; allow in the band or with `/pkg-allow`.
- **Read Guard** (new): holds whole-file reads of large files, lockfiles, minified code and source maps (also `cat`/`type`/`Get-Content`) and names a better way; the second try goes through.
- **Desktop Pet** (new, Windows, off by default): an always-on-top box with a speech bubble that says what Claude is doing and sums up each turn.
- **Codebase Map** (new): feature map of the repo with a freshness band, a CLAUDE.md pointer and an on-demand mapper; the Filetree shows the features in its own tab.
- **Filetree**: right-click *Open with* (default app, found editors, IDEs and browsers by file type).
- **Built into Claude Code**: the window lists and switches Claude Code's built-in mods. **Heads-up retired** in favour of the built-in "You should know".
- **CI Watch** notifies on red and leaves new PRs in the desktop app to the app; **Subagent Saver** stays out when `CLAUDE_CODE_SUBAGENT_MODEL` is set.
- **Native management**: plugins the box cannot carry (skills, agents, MCP/LSP servers, classic hooks …) stay plugins of their own, installed, switched, configured, updated and removed from the window; import inspects first and refuses what it cannot carry.
- Updates for every original (also folders without git, media and binary files); typed option defaults; required options gate switching on.
- claude-mods also offers Package Guard, Read Guard and Desktop Pet on their own.

## 0.4.1

- `tools/box.mjs export`: standalone plugins for single mods, published as the claude-mods marketplace.
- README: the box is described as a best-of selection that takes any other mods; terminal screenshots.
- Window: a short parenthesis no longer cuts a mod's tagline; the header shows the profile the switches match.

## 0.4.0

- **Subagent Saver** (new): built-in Explore subagents without a model of their own run on Sonnet (or Haiku) instead of inheriting the main model.
- **Cache Meter**: the cold-send guard names the cost of compacting first; new option *auto-compact at* sets Claude Code's `autoCompactWindow`.
- **Compatibility**: every mod declares surfaces, systems and needed tools; the window warns when a mod would not run here. The OS is detected with `uname` where it is not Windows.
- **Profiles are rules** over mod attributes, so new mods join the right profiles; the window remembers the applied profile (*Default* until one is applied) and marks new mods.
- **Trust for foreign code**: imported mods stay off in every profile until trusted.
- **Skill `mod-box-add`**: Claude imports, classifies, credits and tests a new mod.
- `tools/box.mjs analyze <id|dir>`: a first guess at a mod's group, tokens, commands and where it runs.
- Everything addressed to Claude is English; the answer language follows the setting. English is the default UI language.
- CI on GitHub Actions (Ubuntu and Windows).

## 0.2.0

- First public version: thirteen mods in one plugin, the window (`/mod-box`) with Mods, Profiles, Sources and Health, upstream updates with three-way merge, token usage per mod, Secret Guard exceptions, CI Watch for pull requests.
