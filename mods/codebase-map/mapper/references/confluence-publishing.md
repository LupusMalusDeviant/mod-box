# Optional level: publish the blueprint to Confluence

Mirrors `docs/blueprints/` into a Confluence page tree: the index page, and one child page per
feature. Markdown stays the source of truth; Confluence is a generated mirror. Publishing is
outward-facing: it is never part of the default flow, and every run that writes needs the user's
explicit "yes" after a preview.

Backend: the **Atlassian MCP** connected in Claude (no install, no token, the user's own Atlassian
login). A publishing CLI your team uses is an alternative (see the end) as long as it reads the same
frontmatter and the same `<!-- confluence-page-id: N -->` comment.

## State kept in the files

- YAML frontmatter at the very top of each published file:

  ```yaml
  ---
  publish: true
  confluence-space-key: <SPACE>
  parent: "<PARENT_PAGE_ID>"        # INDEX.md: the page the tree hangs under; features: the INDEX page id
  title: "<Repo>: <Feature name>"  # INDEX.md: "<Repo>: Codebase-Blueprint" (en: "<Repo>: Codebase Blueprint")
  tags: [docs-as-code, codebase-blueprint, <repo-slug>]
  ---
  ```

- Right below it, after the first publish: `<!-- confluence-page-id: N -->`. It is what makes the
  next run update instead of create. Keep it, and remind the user to commit it.

Titles carry the repo name because Confluence titles are unique per space. Never touch anything
else in the files; in particular never rewrite the `](./<slug>.md)` links: the codebase-map mod
and the incremental mode read them. Link conversion happens only in the published body.

## Procedure (Atlassian MCP)

### 7.1 Connect and target

1. `getAccessibleAtlassianResources` once; use that `cloudId` for every call.
2. Space and parent: reuse `confluence-space-key` and `parent` from `INDEX.md` when present and only
   confirm them; otherwise ask via `AskUserQuestion` for the space key and the parent page (id or URL;
   "Other" lets the user type it).
3. `getConfluenceSpace` (via `executeRead`, `inputs={spaceIdOrKey}`) once: the numeric space id for
   `parent.spaceId`, and any `spaceInstructions`, which apply to every page body.
4. `getContentFormatGuide` (via `executeRead`, `inputs={toolName: "createConfluencePage"}`) once.
5. For operations reached through `executeRead`/`executeWrite` (`getConfluenceSpace`,
   `listConfluenceContentVersions`, `addLabelsToConfluenceContent`), take the exact input names
   from `discover` once; never guess them.

If the MCP is not connected or answers without Confluence write access, stop the level, say so,
and log it as `skipped`.

### 7.2 Privacy and secrets check (blocking)

Before anything leaves the machine, scan every file to publish for secrets (API keys, tokens,
passwords, private keys, credentials in connection strings) and personal data, especially customer
data (e-mail addresses, phone numbers, IBANs, postal addresses, customer names or ids). Any hit:
show file and line with the value masked, publish nothing, let the user decide how to fix it.
Customer personal data never goes into published content.

### 7.3 Plan and preview

**Scope first.** When the prompt names features ("nur das Feature X", "only the feature X"), the plan
holds the index page plus exactly those features; the index page is created when it has no page id
yet, otherwise it is left alone unless its file changed. When the prompt does not say, ask via
`AskUserQuestion`: "Gesamter Blueprint" / "Nur ausgewählte Features" (then a multi-select of the
features) / "Abbrechen" (in English: "Whole blueprint" / "Selected features only" / "Cancel"). A
prompt that still contains a placeholder such as `<URL …>` has no target yet: ask for the parent
page instead of guessing.

Build the plan from the files in scope: per file `create` (no page id yet), `update` (page id and the
file changed in this run or the user asked for a full sync) or `skip`. Before an `update`, read the page
(`getConfluenceContent`, `detail: "summary"`) and its latest version
(`listConfluenceContentVersions` via `executeRead`, limit 1). The page is untouched since the last
sync when that version is version 1 (created by this flow) or its message starts with
`codebase-mapper sync`. Anything else means someone edited it in Confluence: mark it
`skip (edited in Confluence)` unless the user explicitly chooses to overwrite it.

Show the plan as a table (file, action, title, parent) and ask via `AskUserQuestion`
("Publish as shown" / "Cancel"). One confirmation covers this run, both passes in 7.5 included.

### 7.4 Convert

Per file, from the Markdown without frontmatter and page-id comment, write an HTML body that follows
the format guide:

- headings, paragraphs, lists, tables (`<th>` header row), inline code;
- code blocks as `<pre><code class="language-…">`;
- Mermaid blocks as described under "Mermaid diagrams" below;
- `](./<slug>.md)` links become `<a href="https://<site>/wiki/spaces/<SPACE>/pages/<id>">…</a>` when
  the target page is published; a link to a feature outside this run's scope and without a page stays
  plain text; other relative links to files in the repo become plain text with the path in `<code>`;
- no Confluence storage XML (`<ac:…>`), as the guide says.

#### Mermaid diagrams

If your Confluence site has a Mermaid macro app installed (for example the Forge app "Mermaid
diagram"), use it. Otherwise fall back to a code block.

**Find the macro.** Ask the user for a page that already uses the macro (or ask them to insert it
once on a test page) and read that page with `getConfluenceContent`, `detail: "full"`. Copy the
extension element as it appears there: its `data-extension-key`, `data-extension-type` and the
`extensionId` and `extensionTitle` inside `data-parameters`. Record the extension key under
**Decisions** in the log entry so later runs can reuse it without asking. If the user has no such
page, or the site has no Mermaid app, use the fallback.

**Forge app "Mermaid diagram".** Its macro carries no diagram source: it draws the n-th **code block
of any language** on the same page, counted from 0 in page order, including blocks inside a
collapsed `<details>`. Per Mermaid block of the Markdown, emit in this order, with the values copied
from the existing page:

```html
<div data-type="extension" data-extension-key="<EXTENSION_KEY>" data-extension-type="com.atlassian.ecosystem" data-layout="default" data-parameters='{"layout":"extension","guestParams":{"index":N},"forgeEnvironment":"PRODUCTION","extensionId":"ari:cloud:ecosystem::extension/<EXTENSION_KEY>","extensionTitle":"Mermaid diagram"}'>Mermaid diagram</div>
<details><summary>Mermaid-Quelle</summary><pre><code class="language-mermaid">…source, HTML-escaped…</code></pre></details>
```

- `N` is the 0-based position of this Mermaid block among **all code blocks** of the page
  (`<pre><code …>`, whatever the language: bash, json, ts, mermaid). Inline `<code>` does not
  count. Example: a page with a bash block, a JSON block and then two diagrams uses `N` = 2 and 3.
  Count per page from the final HTML before writing; a wrong index draws the wrong block and shows
  "No diagram type detected".
- English output: `<summary>Mermaid source</summary>`.
- Do not add `embeddedMacroContext`, `localId` or account ids: Confluence fills the context itself.
- Another Mermaid app may expect the source inside the macro instead of an index. Follow the
  structure of the existing page in that case.

**Fallback.** Without a usable macro, or when a page renders an empty macro box, emit the bare
`<pre><code class="language-mermaid">` block and tell the user that diagrams appear as source.

### 7.5 Write

Two passes, so every link resolves on the first run:

1. **Create pass** (only when the plan has `create` entries): create the index page first, then
   each new feature page under it, with `createConfluenceContent` (`contentType: "page"`, `title`,
   `parent: { spaceId, parentContentId }`) and a one-line placeholder body ("Wird aus
   `docs/blueprints/` veröffentlicht." / "Published from `docs/blueprints/`."). After each create,
   write `<!-- confluence-page-id: N -->` right below the frontmatter, and set the features'
   `parent` to the index page id. Add the labels with `addLabelsToConfluenceContent` (via
   `executeWrite`): `docs-as-code`, `codebase-blueprint` and the repo slug.
2. **Fill pass**: now that every page id is known, convert (7.4) and update every page of the plan:
   `getConfluenceContent` with `detail: "full"` for the `snapshotToken`, then
   `updateConfluenceContent` with `contentId`, the `body`, `title`, and
   `versionMessage: "codebase-mapper sync <stamp>"` (the INDEX commit stamp). Large plans may run
   several updates per turn; report progress in one short line per batch.

Conversions can be done in context or with a throwaway script in the session's scratchpad or temp
directory; never put helper scripts into the repository.

Never delete pages. A feature that disappeared from the blueprint keeps its page: report it so the
user can archive it in Confluence.

### 7.6 Afterwards

Report the page URLs, the pages skipped as edited in Confluence, and orphaned pages. Tell the user
that the frontmatter and page-id comments must be committed, and offer to commit them; otherwise
the next run creates duplicates.

## Re-runs

When `INDEX.md` carries `publish: true`, after an incremental update offer "Also update
Confluence?" (`AskUserQuestion`, "No" first). On yes: give new feature files the frontmatter
(parent = the INDEX page id), run 7.2, then plan, preview and write only the files this run changed,
plus the index.

## Alternative backend: a publishing CLI

Use a publishing CLI your team uses only when the user asks for it, for example for checksum-based
change detection. Do not install or configure it yourself and never handle its token. Its Mermaid
conversion may target a macro that is not installed on the site; in that case diagrams render
through the MCP path above and may not render through the CLI.

The workflow stays the same: dry run first, confirm, publish `INDEX.md`, read the INDEX page id, set
the features' `parent`, then dry run, confirm and publish `docs/blueprints`; run it once more when
pages were created, so links between them resolve. **Never use an option that rewrites the
`./<slug>.md` links in the source files.**
