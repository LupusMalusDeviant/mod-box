---
name: relay-orchestrator
description: How to run persistent worker sessions with the relay plugin (tools mcp__relay__worker_send, worker_status, worker_expand): separate Claude Code sessions started via CLI that keep their own context per role and report back as compact relay packets. Use when the user wants long-running parallel roles (e.g. ingester, architect/system engineer, researcher) on one knowledge base or codebase, says "relay", "Worker-Sessions", "Multi-Session", "Rollen parallel arbeiten lassen", "Main-Agent steuert Sessions", "an den Ingester geben", or when work needs roles that remember earlier tasks. Also use when a "[relay] <role> · run <n> finished" message arrives. Do NOT use for one-shot parallel lookups or short searches (use ordinary subagents), for a single task that fits in this session, or inside a worker session (workers have no relay tools).
---

# Relay orchestrator

The relay lets you, the **main agent**, hand work to **workers**: separate Claude Code sessions, one per **role**, started in the background via the `claude` CLI. A role keeps its session, and with it its context, across tasks. Workers never talk to the user or to each other; everything flows through you as **relay packets**, compact summaries that keep every essential (decisions, file changes, blockers, exact identifiers) and leave the details on disk.

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
`{ role, task, brief?, owns?, model?, effort?, allowedTools?, disallowedTools?, fresh? }`

Starts the role's next run, or queues it, and returns at once. It never waits for the result.
- `role`: lowercase name (`a-z 0-9 - _`). The first send creates the role.
- `task`: the complete instruction for this run (see *Writing a task*).
- `brief`, `owns`, `model`, `effort`, `allowedTools`, `disallowedTools`: stored for the role and reused by later sends. Give them once, when creating a role, or put them in the roles file.
- `fresh: true`: the next run starts a new session, so the role forgets everything. Only possible while the role is idle and has nothing queued.

### `mcp__relay__worker_status`
Lists every role (stored and from the roles file): `working`, `queued`, `idle` or `defined, never run`, the number of runs, the last status and summary, owned paths, model. It also shows running/queued counts and, when the user picked toast delivery, the packets that arrived unread.

### `mcp__relay__worker_expand`
`{ role, run?, section?, maxChars? }`: details behind a packet.
- `section: "<heading>"`: one section of the worker's full answer (the packet lists the headings). **Preferred.**
- `section: "packet"`: the complete packet, for when lean packets held facts or risks back.
- no section: the whole answer, cut at `maxChars` (default 12000). Use rarely.
- `run` defaults to the latest finished run. Old runs rotate out after the user's `keepRuns`.

Everything is also on disk: `<relayDir>/runs/<role>/<slot>.full.md` (task + full answer) and `.packet.json`.

## Setting up roles

A role is defined by:
- **brief**: what the role is for and what it must never do. One or two sentences.
- **owns**: the paths it may write (folders end with `/`). Enforced in the worker for Edit, Write and NotebookEdit when the user keeps `enforceOwns` on; shell writes are not caught, so also forbid risky shell use via `disallowedTools`.
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

A packet arrives as a message headed `[relay] <role> · run <n> finished (<turns>, <cost>)`. Depending on the user's settings it starts a turn by itself (`prompt`), appears at your next turn (`note`), or waits in `worker_status` (`toast`).

Work through it in this order:
1. **Status**: `done`, `partial`, `blocked` or `failed`. On `failed`, or `(packet built by fallback compressor)`, look once with `worker_expand`.
2. **Needs from main / open questions**: decide yourself, ask the user, or route to the owning role. Never leave them dangling.
3. **Decisions**: carry them into later tasks of roles that depend on them.
4. **Artifacts**: what changed on disk. `refused` means a write was blocked by ownership. Route the change to the owner or adjust `owns`.
5. **Risks**: resolve conflicts between roles before sending more work.
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
| `failed` with stderr mentioning the executable | The `claude` CLI was not found; the user must set the plugin's `claudeBin` |
| `stopped after N min` | The task was too big for the timeout; split it and resend |
| a cost close to the budget, status `partial` | Budget per run hit; split the task, or ask the user to raise `maxBudgetUsd` |
| `refused` artifacts | Route the change to the owning role, or ask the user to widen `owns` |
| answers drifting, role confused | `fresh: true` on the next send (the role forgets everything) |
| "has work in flight" on `fresh` | Wait for the packet, then send with `fresh` |
| packets stop arriving after the plugin reloaded or the session restarted | Running workers were stopped and queued tasks lost; check `worker_status` and resend. Sessions are kept, so roles resume with their context |

## Rules

- Never pretend a worker finished: wait for its packet. Never invent a packet's content.
- Tell the user, in one line, which role you dispatched and why; report packets in your own words, short.
- Do not raise models, effort, budgets or tool rights beyond the user's settings without asking.
- Workers run unattended with the permission mode the user chose; do not give them tasks you would not run without asking the user (pushing, deleting, spending).
- Workers have no relay tools; a worker cannot start further workers.
