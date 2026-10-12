# codebase-map: mapper instructions

These instructions build and maintain a structured blueprint of an existing codebase: one Markdown file per feature plus a central index, under `docs/blueprints/`. The work is read-only: source code is never modified.

The codebase-map mod points you to this file when a prompt mentions a blueprint. The hint names the absolute path of this folder; below it is written as `<mapper-dir>`. Relative paths such as `references/heuristics.md` and `scripts/edges.mjs` are relative to this folder. This file is in English; dialogue with the user follows the user's language.

## When these instructions apply

Follow them when the user wants one of these four things:

- **Create** a blueprint: "erstelle einen Bauplan / Blueprint für diese Codebase", "create a blueprint", "build feature docs", "map the repo into docs/blueprints".
- **Update** it: "aktualisiere den Blueprint", "update the blueprint", "update the blueprint for the feature X".
- **Check freshness** without writing: "ist der Blueprint noch aktuell?", "is the blueprint still up to date?" (see the quick path below).
- **Mirror it to Confluence**: "veröffentliche den Blueprint in Confluence", "publish the blueprint to Confluence" (Step 7).

## When they do not apply

The hint fires on any prompt that contains the word "blueprint" or "Bauplan". Ignore this file and answer normally when the prompt is about something else:

- Quick lookups ("What does function X do?", "Why does Y throw?"): these need an answer in chat, not a blueprint.
- README or marketing copy: these instructions produce engineering blueprints for developers, not product-facing text.
- Refactoring or clean-up requests: this workflow does not touch code. Changes belong to a coding workflow.
- API docs from OpenAPI/Swagger: if a spec file exists, a spec generator is the better tool.
- Other meanings of the word, for example Flask `Blueprint` objects or Unreal Engine Blueprints.

## Purpose

- Make a foreign or grown codebase readable by slicing it into **features** (business or technical units).
- Each feature gets its own Markdown file covering purpose, file list, internal and external dependencies, public API/interface, and data/call flow.
- A top-level `INDEX.md` ties the features together with an overview, a path mapping and a machine-checked dependency graph.
- Blueprints land in `docs/blueprints/` in the repo root, versioned alongside the code.

## Output language

The generated blueprints are written in the **configured output language**:

- **Default: German.**
- **Per-run override:** the user can request any language ("schreib die Blueprints auf Englisch" / "write the blueprints in English").
- **Persistent override:** if the repo's `CLAUDE.md` or `agent-instructions.md` specifies a documentation language, use that. The codebase-map mod writes this line into its `CLAUDE.md` block according to its `language` option ("Dokumentationssprache des Blueprints: Deutsch" / "Blueprint documentation language: English").

The templates under `references/` are written in German. When another output language is active, keep their exact structure and translate headings and labels (the mod reads `## Dateien` or `## Files`, `### Intern` or `### Internal`, `## Zuordnung` or `## Mapping`; the script prints `## Kanten (geprüft)` or, with `--lang en`, `## Edges (verified)`). Exception: the commit-stamp line in `INDEX.md` is a machine-readable anchor and is always written verbatim as `**Stand (Commit):** <hash>`, regardless of language. The language applies to everything this workflow writes: blueprints, index, log and Confluence page titles.

## Writing style

Blueprints are reference material for engineers and agents. Write like a careful colleague, not like a text generator. These rules apply to every file this workflow writes and to Confluence pages, in every language:

- **No dashes as sentence connectors.** No em dash (—) and no spaced en dash ( – ) between clauses or after a label. Use a period, comma, colon, semicolon or parentheses instead. Hyphens in compound words and ranges like `3-30` are fine.
- **No filler and no stock phrases**, for example "spielt eine zentrale Rolle", "nahtlos", "robust", "umfassend", "darüber hinaus", "es ist wichtig zu beachten", "im Wesentlichen", "zusammenfassend"; in English "plays a key role", "seamless", "robust", "comprehensive", "leverage", "it's worth noting", "in essence", "overall". Say what the code does instead.
- **No rhetorical patterns**: no "nicht nur X, sondern auch Y" / "not just X, but Y", no triads for rhythm, no rhetorical questions, no closing "Fazit" or "In summary" paragraph.
- **Concrete over abstract**: name the file, function, endpoint or package from the code. Use the code's own names; do not invent marketing names.
- **Plain formatting**: bold only for the labels the templates define, no emoji, no exclamation marks, no headings for a single sentence.
- **Short declarative sentences**, active voice. Uncertain points go under "Offene Fragen / TODOs" instead of hedging every sentence ("möglicherweise", "potentially").
- German text uses German quotation marks („…“) in prose; code, paths and identifiers stay in backticks.

Before writing a file, check its text against these rules and rewrite the sentences that break them.

## Workflow

### Step 1: Clarify the frame

Before scanning:

1. **Detect a re-run and determine staleness.** If blueprint files already exist under `docs/blueprints/`:
   1. Read the commit stamp from `INDEX.md` (the line `**Stand (Commit):**`).
   2. If the repo is a git repo and a stamp exists, collect the files changed since then:
      ```bash
      git diff --name-only <stamp>..HEAD -- . ':(exclude)docs/blueprints' ':(exclude)docs/SkillUsed' ':(exclude)CLAUDE.md' ':(exclude).claude/CLAUDE.md'
      git status --porcelain -- . ':(exclude)docs/blueprints' ':(exclude)docs/SkillUsed' ':(exclude)CLAUDE.md' ':(exclude).claude/CLAUDE.md'
      ```
      (The second command catches uncommitted changes.) The pathspec excludes this workflow's own output and the `CLAUDE.md` pointer the codebase-map mod maintains: the stamp is written before the blueprints are committed, so without it every blueprint and log file would show up as a changed, unassigned path. Use the long form `:(exclude)`, not `:!`, which interactive Bash expands.
   3. Map the changed paths to the features in `INDEX.md` (each feature file lists its files). Result: the list of **stale features**, plus any paths that belong to no known feature (candidates for new features).
   4. Show the user the result ("N files changed since `<stamp>`, affecting features X, Y; Z unassigned paths") and ask via `AskUserQuestion`:
      - "Update incrementally" (rewrite only stale features and new candidates, leave the rest untouched)
      - "Regenerate everything" (overwrite all)
   5. **Fallback:** no git repo, no stamp in `INDEX.md`, or the stamp commit no longer exists (for example after a rebase; `git cat-file -t <stamp>` fails): tell the user that no diff is possible and ask the same question; in incremental mode you then judge staleness yourself by comparing files.
2. **Scope:** whole repo or only a subpath (`src/`, one subfolder)? Clarify via `AskUserQuestion`.

Skip questions whose answer is already clear from the user's prompt. The diff check (1.1-1.3) always runs when a blueprint exists: it is cheap and determines how much work lies ahead.

### Quick path: staleness check without writing

If the user only asks about freshness ("is the blueprint still up to date?", "what changed since the blueprint?"), run only steps 1.1-1.3 and report the result: which features are stale, which paths are unassigned, and offer the incremental update. Write no files and launch no Explore agent; write only the log entry (see Logging) with status `skipped` if the user declines the update.

### Step 2: Survey the repository

Use `Agent` with `subagent_type: Explore` to scan the repo broadly. Give the subagent:

- the chosen scope (repo root or subpath),
- the task of identifying **features** (coarse units such as "Authentication", "Billing", "User Profile", "CLI Commands", not individual files),
- the request to list, per feature, the associated file paths, public APIs/exports, and external dependencies.

For feature-detection heuristics see `references/heuristics.md`. Read that file only when detection is unclear.

If the repo is small (fewer than 30 relevant source files), work directly with `Glob` and `Grep` instead of an Explore agent.

**In incremental mode with a diff:** no full repo scan. Limit the analysis to the stale features (their file lists are known from the existing feature files) plus the unassigned paths from the diff. Run a targeted Explore pass over those paths only when they hint at a new feature.

### Step 3: Confirm the feature list and the path mapping

Before writing any files, show the user the detected features as a numbered list and ask for confirmation or correction. A short text is enough; no `AskUserQuestion` needed, the user can reply directly.

Give every feature its **path globs** (`src/Auth/**`, `src/Services/Rag/*.cs`, `dotnet/src/App/Controllers/ChatController.cs`) and a **role**:

- `fach` / `domain`: a normal feature.
- `Vertrag` / `contract`: a pure contract layer (interfaces, models, DTOs, for example `Core`, `Shared`, `Abstractions`). Edges into it are not drawn; the script resolves them to the feature that implements the interface.
- `Querschnitt` / `cross-cutting`: infrastructure many features use (settings, audit, identity, logging).

Every source file outside tests and build output must belong to exactly one feature; the most specific glob wins. In layered repos (one project with `Controllers/`, `Services/`, `Auth/`) map single files or file patterns, not whole layer folders. Shared helpers that belong to no feature are fine; name them, the script reports them as unassigned.

Reason: feature boundaries are the most important design decision of the blueprint, and the mapping is what makes the edges in Step 4 verifiable. Ask once rather than write 20 wrong files.

### Step 4: Write the blueprints

#### 4.0 Extract the edges (script, not prose)

Feature dependencies are never written from memory. Agents rely on them to decide what a change does not touch, and hand-written edges tend to be wrong (missing runtime dependencies, invented project references). Instead:

1. Write `docs/blueprints/INDEX.md` with the feature table and the `## Zuordnung` section from Step 3 first (see `references/index-template.md`); the rest of the index follows in Step 5.
2. Run the script from this folder (no install, needs Node and git):
   ```bash
   node "<mapper-dir>/scripts/edges.mjs" "<repo-root>" --lang de     # or --lang en
   ```
   It assigns every source file to a feature, reads declarations, interface implementations, type references and manifest references (`csproj` ProjectReference, `package.json` workspaces), and prints the `## Kanten (geprüft)` section: a table `Von | Nach | Art | via | Beleg` plus the Mermaid graph generated from it. Kinds: `Build` (manifest), `Typ` (uses a type declared in the other feature), `Laufzeit` (uses an interface the other feature implements, typically DI), `HTTP` (names a route string that matches a server route of the other feature: controller `[Route]`, `MapGet`, Express routers), `Querschnitt` (cross-cutting, table only).
3. Read the HTML comments at the end of the output. Unassigned or doubly assigned files mean the globs are incomplete: fix the `## Zuordnung` and run again until only deliberate leftovers remain. Name deliberate leftovers (legacy code, generated files) in one sentence under the mapping table. The feature table and the mapping must use the same slugs; the script warns about mapping rows it cannot match. Do not edit the edge table by hand; if an edge looks wrong, fix the mapping or the roles.
   - Composition roots (`Program.cs`, `Startup.cs`, `*ServiceExtensions.cs`, `DependencyInjection/`) produce no edges by design: registering a service is not using it. The feature that owns them gets its edges from the build manifests.
   - Features with the role `Querschnitt` stay as isolated nodes in the graph; their edges are listed in the table only.
4. **No Node available:** tell the user, then build a reduced table by hand only for interfaces in the contract layer (grep implementers and users) plus the manifest references, and title the section `## Kanten (manuell, ungeprüft)` so agents know it was not machine-checked.

#### 4.1 Feature files

For each confirmed feature:

1. Read `references/blueprint-template.md` once (enough for the whole session).
2. Fill in every section in the output language:
   - **Purpose:** 1-3 sentences on what the feature does and why it exists.
   - **Files:** list of the central source files (relative paths), briefly annotated.
   - **Dependencies:** internal: exactly the outgoing edges of this feature from the edge table (with their kind and `via`), no others; external: npm/pip/cargo/NuGet packages.
   - **Public API / interface:** exports, props, endpoints, CLI flags; everything other features or external consumers use.
   - **Data flow / call flow:** how the parts work together; a Mermaid sequence or numbered steps.
   - **Evidence for behaviour:** every statement about runtime behaviour ("logs every request", "creates the index on startup", "the UI streams the answer") carries its source as `Datei:Zeile` in backticks, with the path relative to the repo root. A statement you cannot point to in the code goes under "Offene Fragen / TODOs", not into the prose. Unsupported behaviour claims are the most common blueprint error.
3. Add Mermaid diagrams where they show more than text. See `references/mermaid-snippets.md`.
4. Write the file to `docs/blueprints/<feature-slug>.md` (kebab-case). Keep slug language consistent across all features.

Easily forgotten: `Read` the target file before `Write` if it exists. In incremental mode, touch only the features identified as stale; features without diff hits stay untouched (do not even re-read them). Preserve the user's manual additions when rewriting a stale feature file. Keep a YAML frontmatter block and a `<!-- confluence-page-id: N -->` comment verbatim: they tie the file to its Confluence page (see Step 7), and losing them creates duplicate pages.

### Step 5: Write the index

Read `references/index-template.md` and complete `docs/blueprints/INDEX.md`:

- Short repo overview (1 paragraph).
- List of all features with a link to each `.md`.
- The `## Zuordnung` section (globs and roles) from Step 3.
- The `## Kanten (geprüft)` section exactly as the script printed it (table, Mermaid graph, legend). It replaces any hand-drawn dependency diagram. Keep the script's HTML comments out of the final file.
- Generation date.
- **Commit stamp**, the anchor for future diff checks: run `git rev-parse HEAD` and write the result as `**Stand (Commit):** <hash>` (verbatim label in every language). If the working tree had changes outside the blueprint (`git status --porcelain -- . ':(exclude)docs/blueprints' ':(exclude)docs/SkillUsed' ':(exclude)CLAUDE.md' ':(exclude).claude/CLAUDE.md'` non-empty; the files this run just wrote do not count), append ` (working tree had uncommitted changes)`. No git repo: `**Stand (Commit):** kein Git-Repo` / `no git repo`.

The stamp is updated on **every** run, including incremental ones; otherwise the next diff grows needlessly.

**Verification run (blocking).** After all files are written, run the script once more with `--check`:

```bash
node "<mapper-dir>/scripts/edges.mjs" "<repo-root>" --lang de --check
```

It lists paths under `## Dateien` that do not exist and backticked identifiers that occur nowhere in the code. Fix every finding in the blueprint (correct the name or path, or remove the claim) and run again until the check comment says `keine Befunde`, or the remaining findings are deliberate (environment variables, file names outside the repo). Re-run the edge extraction in incremental mode too: it is cheap, and the edge table must match the current code.

### Step 6: Summary

Tell the user in 2-3 lines:

- how many feature `.md` files were created,
- the path to `INDEX.md`,
- that the source code was not modified.

Do not repeat the content; the user can read the files.

### Step 7 (optional): Publish to Confluence

A user decision, never automatic. After the summary ask via `AskUserQuestion` whether to mirror the blueprint into Confluence ("Not now" first, "Publish to Confluence"). Skip the question when the user already said so in the prompt, and ask "Also update Confluence?" instead when `INDEX.md` already carries `publish: true`. Start here directly when the user only asks to publish an existing blueprint.

On yes, read `references/confluence-publishing.md` and follow it. The backend is the Atlassian MCP (no install): settle space and parent page, run the blocking privacy and secrets check, show the create/update/skip plan and get confirmation, then write the index page first and the features under it, keeping the page ids in the files. A publishing CLI your team uses is an alternative only when the user asks for it. Never rewrite the `./<slug>.md` links in the source files, and never let a tool do it: the incremental mode and the codebase-map mod depend on them.

## Logging

After every run (completed or aborted), record the run in `docs/SkillUsed/codebase-mapper.md`. Create folder and file if they don't exist; `Read` the file first, otherwise `Write` it fresh with a header. Write log entries in the output language.

Format: new entries always go **on top** (most recent run first), separated by `---`.

```markdown
## YYYY-MM-DD HH:MM · Run

**Task:** <1-2 sentences on what the user wanted>

**Decisions:**
- <gate / question>: <chosen answer>

**Artifacts:**
- <path of each created or updated file>

**Status:** completed | aborted | skipped

---
```

Date and time local as `YYYY-MM-DD HH:MM`. If aborted midway, set status to `aborted` and still record the decisions made and artifacts produced so far; the log reflects what happened, even when incomplete.

## Output

A folder `docs/blueprints/` in the repo root containing:

- `INDEX.md`: overview, path mapping, machine-checked edge table and graph, commit stamp
- `<feature-slug>.md`: one file per feature (in the output language, Mermaid where useful)

All source files remain unchanged.

## The codebase-map mod

This folder ships inside the codebase-map mod, which also:

- keeps a block between `<!-- codebase-map:start -->` and `<!-- codebase-map:end -->` in the repo's `CLAUDE.md` that tells agents to read `docs/blueprints/INDEX.md` first. Do not write or edit that block yourself; the mod maintains it as soon as `INDEX.md` exists. With the mod option `claudeMd=off` it never writes the block and removes an existing one at the next session start. Outside that block, never touch `CLAUDE.md`.
- reads `INDEX.md` and the feature files to draw the `/codebase-map` pane and the freshness band above the prompt. It parses the feature table rows (`| Name | summary | [slug.md](./slug.md) |`), the globs under `## Zuordnung`, the Mermaid `graph` edges (`-->` and `-.->`), the `### Intern` links and the backticked paths under `## Dateien`, so keep the templates' structure.

If a `CLAUDE.md` exists in the repo (for example created with `/init`), also link it in `INDEX.md` under related docs.

## Reference files

- `references/blueprint-template.md`: Markdown template for one feature file. Read once per session before writing the first feature `.md`.
- `references/index-template.md`: template for the central `INDEX.md`.
- `references/mermaid-snippets.md`: Mermaid patterns. Read only when diagrams are needed.
- `references/heuristics.md`: heuristics for feature detection and dependency mapping. Only for unclear repo structures.
- `references/confluence-publishing.md`: the optional Confluence level (Step 7). Read only when the user chose to publish.
- `scripts/edges.mjs`: edge extraction and blueprint check (Step 4.0 and the verification run in Step 5). Run it, do not read it.

## Do not

- Do not edit source code. This workflow is read-only.
- Do not publish to Confluence without a dry run and the user's explicit confirmation, and never publish secrets or customer data.
- Do not overwrite blueprints without reading them first; this applies especially in incremental mode.
- Do not force Mermaid diagrams on trivial features. A three-box diagram helps nobody.
- No generic filler prose ("This module is important because …"). If you have nothing concrete to say, write less and ask the user.
