---
name: relay-orchestrator
description: How to run persistent worker sessions with the relay plugin (tools mcp__relay__worker_send, worker_status, worker_expand): separate Claude Code, Codex or OpenCode sessions started via CLI that keep their own context per role and report back as compact relay packets. Use when the user wants long-running parallel roles (e.g. ingester, architect/system engineer, researcher) on one knowledge base or codebase, says "relay", "Worker-Sessions", "Multi-Session", "Rollen parallel arbeiten lassen", "Main-Agent steuert Sessions", "an den Ingester geben", or when work needs roles that remember earlier tasks. Also use when a "[relay] <role> · run <n> finished" message arrives. Do NOT use for one-shot parallel lookups or short searches (use ordinary subagents), for a single task that fits in this session, or inside a worker session (workers have no relay tools).
---

# Relay orchestrator

The relay lets you, the **main agent**, hand work to **workers**: separate sessions, one per **role**, started in the background via a CLI. Each role picks its **backend**: `claude` (Claude Code, the default), `codex` (Codex CLI) or `opencode` (OpenCode, which also reaches Ollama and OpenRouter models). A role keeps its session, and with it its context, across tasks. Workers never talk to the user or to each other; everything flows through you as **relay packets**, compact summaries that keep every essential (decisions, file changes, blockers, exact identifiers) and leave the details on disk.

Your two duties: **keep your own context small**, and **still know every input and every essential output**.

## When to use it, and when not

| Use the relay | Use something else |
|---|---|
| Roles that work for a long time and should remember earlier tasks (an ingester fed batch after batch) | One-shot lookups, searches, a quick review → ordinary subagents |
| Work that runs while you keep talking to the user | A task you can finish yourself in a few steps |
| Several roles writing different parts of one project | Two roles that would edit the same files → one role, or split ownership first |
| Big jobs that would flood your context (20 links, a long research) | Anything needing the user's interactive approval mid-way (workers cannot ask) |

Each worker run is a full Claude Code session with its own cost. Do not spin up workers for trivial work.

## The tools

### `mcp__relay__worker_send`
`{ role, task, brief?, owns?, model?, effort?, allowedTools?, disallowedTools?, backend?, isolation?, fresh? }`

Starts the role's next run, or queues it, and returns at once. It never waits for the result.
- `role`: lowercase name (`a-z 0-9 - _`). The first send creates the role.
- `task`: the complete instruction for this run (see *Writing a task*).
- `brief`, `owns`, `model`, `effort`, `allowedTools`, `disallowedTools`, `backend`, `isolation`: stored for the role and reused by later sends. Give them once, when creating a role, or put them in the roles file.
- `backend`: `claude`, `codex` or `opencode`. Changing it drops the role's session (the answer says so).
- `model`: in the backend's format. opencode needs `provider/model`, e.g. `ollama/kimi-k3:cloud` or `openrouter/<vendor>/<model>`.
- `isolation: "worktree"`: the role works in its own git worktree `.relay/worktrees/<role>` on branch `relay/<role>`. relay never merges it; the packet names the branch under *Needs from main*.
- `fresh: true`: the next run starts a new session, so the role forgets everything. Only possible while the role is idle and has nothing queued.

The send's answer lists rules the backend cannot apply (`codex ignores: allowedTools`). Do not rely on those.

### `mcp__relay__worker_status`
Lists every role (stored and from the roles file): `working`, `queued`, `idle` or `defined, never run`, the number of runs, the last status and summary, backend and its version, model, owned paths, total usage and ignored rules. It also shows running/queued counts, the waiting jobs, notes (a broken queue file, an unchecked CLI version) and, when the user picked toast delivery, the packets that arrived unread.

### `mcp__relay__worker_expand`
`{ role, run?, section?, maxChars? }`: details behind a packet.
- `section: "<heading>"`: one section of the worker's full answer (the packet lists the headings). **Preferred.**
- `section: "packet"`: the complete packet, for when lean packets held facts or risks back.
- no section: the whole answer, cut at `maxChars` (default 12000). Use rarely.
- `run` defaults to the latest finished run. Old runs rotate out after the user's `keepRuns`.

Everything is also on disk: `<relayDir>/runs/<role>/<slot>.full.md` (task + full answer), `.packet.json` (with `backend`, `usage` and `write_check`) and `live.log` (what the current or last run did, event by event for codex and opencode).

## Setting up roles

A role is defined by:
- **brief**: what the role is for and what it must never do. One or two sentences.
- **owns**: the paths it may write (folders end with `/`). In claude workers it is enforced for Edit, Write and NotebookEdit when the user keeps `enforceOwns` on. For every backend, relay also compares git before and after each run (the write check): a write outside `owns` turns `done` into `partial`, lands under *Risks* and marks the head line `⚠ wrote outside owns (n)`. The check reports, it does not undo.
- **backend**: `claude` for most work; `codex` runs in its OS sandbox (`workspace-write`, no network, so no push); `opencode` for Ollama or OpenRouter models. Prefer `isolation: "worktree"` for codex and opencode roles that write while other roles write too.
- **model / effort**: cheap and low for mechanical roles (ingesting), stronger for design or research.
- **allowedTools / disallowedTools**: tool rules in Claude Code syntax, e.g. `Read`, `WebFetch`, `Bash(git status:*)`.

For a project with fixed roles, use the **roles file** (default `.relay/roles.json`, meant to be committed) instead of repeating them in every send:

```json
{
  "roles": {
    "ingester": {
      "brief": "Turns links and documents into source notes. Never changes structure or templates.",
      "owns": ["wiki/sources/"],
      "model": "claude-haiku-5-5",
      "effort": "low",
      "allowedTools": ["Read", "Write", "WebFetch"],
      "disallowedTools": ["Bash"]
    },
    "architect": {
      "brief": "Owns the wiki structure, templates, tags and linking rules.",
      "owns": ["wiki/_schema/", "wiki/index.md"],
      "effort": "high"
    },
    "researcher": {
      "brief": "Answers questions from the wiki and the web; writes research notes.",
      "owns": ["wiki/research/"]
    }
  }
}
```

**Precedence:** values given to `worker_send` (stored for the role) > roles file > the plugin's settings. If the user asks for roles, offer to write this file for them.

**Ownership rules of thumb:** no two roles own the same path. Shared index files belong to exactly one role; the others report needed changes through `needs_from_main`.

## Writing a task

A worker sees only its own earlier runs and your task. It does not see this conversation, the user, or other roles. So every task is self-contained:

1. **Goal:** what to do, in one sentence.
2. **Inputs:** exact paths, URLs, IDs. Never "the file we discussed".
3. **Constraints:** decisions it must respect, quoted from earlier packets (with their `F` ids when they are facts).
4. **Done means:** what must exist or be answered at the end.
5. **Size:** small enough to finish within the user's budget and timeout. Split "ingest 20 links" into batches of 5.

Good:
> Ingest these 5 links into source notes under wiki/sources/: <urls>. Use the template wiki/_schema/source.md (decision from architect run 3: tags lowercase, one note per link). Done: one note per link, plus a list of links that failed and why.

Bad:
> Do the links from before.

The worker already knows the relay protocol; you do not need to explain packets in the task.

## Handling a packet

A packet arrives as a message headed `[relay] <role> · run <n> finished (<backend> · …)`, e.g. `(claude · 6 turns, $0.42)` or `(codex · gpt-5.5-codex · 48.2k in / 3.1k out tokens)`. Depending on the user's settings it starts a turn by itself (`prompt`), appears at your next turn (`note`), or waits in `worker_status` (`toast`).

Work through it in this order:
1. **Status**: `done`, `partial`, `blocked` or `failed`. On `failed`, or `(packet built by fallback compressor)`, look once with `worker_expand`.
2. **Needs from main / open questions**: decide yourself, ask the user, or route to the owning role. Never leave them dangling.
3. **Decisions**: carry them into later tasks of roles that depend on them.
4. **Artifacts**: what changed on disk. `refused` means a write was blocked by ownership. Route the change to the owner or adjust `owns`.
5. **Risks**: resolve conflicts between roles before sending more work. `wrote outside owns` means the role broke its ownership: check the file, route or revert it. `probably by <role>` and `not attributable` come from roles running in the same folder at once.
6. **Facts / next suggested**: use them for the next tasks.

Do **not** expand by reflex. Most packets are enough as they are; the point of the relay is that your context stays small.

Keep a short ledger in your replies to the user when several roles are active, e.g.:
> ingester: run 4 done, 5 notes · architect: working · researcher: blocked, needs a decision on X

## Handover between roles

Results never flow directly between workers. You are the router:

1. `ingester` finishes a batch; its packet lists new notes and facts.
2. You pass what matters to the next role, with paths and decisions quoted: to `architect` if the batch needs structure, to `researcher` with a question.
3. Meanwhile you keep working with the user or dispatch other roles.

Only one task per role runs at a time; a second send for a busy role waits in the queue and starts by itself. At most `maxParallel` workers run at once. `worker_status` shows the queue.

## Failure handling

| What you see | What to do |
|---|---|
| `failed` with "could not start …" | The CLI was not found; the user must set `claudeBin`, `codexBin` or `opencodeBin` to the full path of the executable |
| `failed (auth)` | The CLI is not logged in; the user logs in to codex or opencode themselves |
| `failed (model)` | Unknown model, or an opencode model without `provider/` |
| "session is gone" | The backend lost the session; the next send starts fresh, so repeat the context the role needs |
| `stopped after N min` | The task was too big for the timeout; split it and resend |
| `stopped at N tokens` | The user's `maxTokensPerRun` hit (codex, opencode); split the task |
| `interrupted` | The plugin reloaded or the session ended while it ran; it is not restarted. Check its write check, then resend if needed |
| "worked by another Claude Code session" | Another session owns this project's queue; use that one |
| a cost close to the budget, status `partial` | Budget per run hit; split the task, or ask the user to raise `maxBudgetUsd` |
| `refused` artifacts | Route the change to the owning role, or ask the user to widen `owns` |
| answers drifting, role confused | `fresh: true` on the next send (the role forgets everything) |
| "has work in flight" on `fresh` | Wait for the packet, then send with `fresh` |
| packets stop arriving after the plugin reloaded or the session restarted | Queued tasks are kept in `.relay/queue.json` and start again; running ones come back as `interrupted`. Sessions are kept, so roles resume with their context |

## Rules

- Never pretend a worker finished: wait for its packet. Never invent a packet's content.
- Tell the user, in one line, which role you dispatched and why; report packets in your own words, short.
- Do not raise models, effort, budgets or tool rights beyond the user's settings without asking.
- Workers run unattended with the permission mode the user chose; do not give them tasks you would not run without asking the user (pushing, deleting, spending).
- Workers have no relay tools; a worker cannot start further workers.
