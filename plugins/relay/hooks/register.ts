import type { Register, EngineInterface } from 'claude-code'
import {
  extractSection,
  fallbackPrompt,
  ownershipDenial,
  parsePacket,
  protocolPrompt,
  renderPacket,
  stripPacket,
  toList,
  type Packet,
} from './protocol.ts'

// What a role is made of. A role's own values (set through worker_send) win
// over the roles file, which wins over the mod's options.
type RoleDef = {
  brief?: string
  owns?: string[]
  model?: string
  effort?: string
  allowedTools?: string[]
  disallowedTools?: string[]
}

type Role = RoleDef & {
  name: string
  sessionId?: string
  runs: number
  isBusy: boolean
  lastStatus?: Packet['status']
  lastSummary?: string
}

type Job = { role: string; task: string; model?: string }

const ROLE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/

const config = {
  claudeBin: 'claude',
  permissionMode: 'acceptEdits',
  workerModel: '',
  workerEffort: 'default',
  maxBudgetUsd: 0,
  maxParallel: 3,
  runTimeoutMin: 30,
  allowedTools: [] as string[],
  disallowedTools: [] as string[],
  enforceOwns: true,
  notifyMode: 'prompt',
  packetDetail: 'full' as 'full' | 'lean',
  fallbackCompress: true,
  fallbackModel: 'claude-haiku-5-5',
  relayDir: '.relay',
  rolesFile: '.relay/roles.json',
  gitignore: true,
  keepRuns: 20,
}

let cwd = ''
let roles: Record<string, Role> = {}
let queue: Job[] = []
let running = 0
let unread: string[] = []
let isGitignoreChecked = false
// Set in a worker session: the paths it may write (empty: unrestricted).
let workerOwns: string[] = []
let workerCwd = ''

function storeKey() {
  return `roles:${cwd}`
}

async function save($: EngineInterface) {
  await $.store.set(storeKey(), roles)
}

function showStatus($: EngineInterface) {
  const busy = Object.values(roles).filter(r => r.isBusy).map(r => r.name)
  const waiting = queue.length ? ` · ${queue.length} queued` : ''
  $.ui.status(busy.length || queue.length ? `relay: ${busy.join(', ') || 'none'} working${waiting}` : undefined)
}

function slotOf(run: number) {
  return config.keepRuns > 0 ? ((run - 1) % config.keepRuns) + 1 : run
}

function runPath(role: string, run: number, kind: 'full.md' | 'packet.json') {
  return `${config.relayDir}/runs/${role}/${String(slotOf(run)).padStart(3, '0')}.${kind}`
}

function isRotatedOut(role: Role, run: number) {
  return config.keepRuns > 0 && run <= role.runs - config.keepRuns
}

async function loadRoleDefs($: EngineInterface): Promise<Record<string, RoleDef>> {
  try {
    if (!(await $.fs.exists(config.rolesFile))) return {}
    const parsed = JSON.parse(await $.fs.read(config.rolesFile)) as Record<string, unknown>
    const map = (parsed.roles ?? parsed) as Record<string, Record<string, unknown>>
    const defs: Record<string, RoleDef> = {}
    for (const [name, d] of Object.entries(map)) {
      if (!ROLE_NAME.test(name) || typeof d !== 'object' || d === null) continue
      defs[name] = {
        ...(typeof d.brief === 'string' ? { brief: d.brief } : {}),
        ...(d.owns !== undefined ? { owns: toList(d.owns) } : {}),
        ...(typeof d.model === 'string' ? { model: d.model } : {}),
        ...(typeof d.effort === 'string' ? { effort: d.effort } : {}),
        ...(d.allowedTools !== undefined ? { allowedTools: toList(d.allowedTools) } : {}),
        ...(d.disallowedTools !== undefined ? { disallowedTools: toList(d.disallowedTools) } : {}),
      }
    }
    return defs
  } catch {
    return {}
  }
}

function effective(role: Role, def: RoleDef | undefined) {
  const effort = role.effort ?? def?.effort ?? config.workerEffort
  return {
    brief: role.brief || def?.brief || '',
    owns: role.owns?.length ? role.owns : (def?.owns ?? []),
    model: role.model || def?.model || config.workerModel,
    effort: effort === 'default' ? '' : effort,
    allowedTools: role.allowedTools ?? def?.allowedTools ?? config.allowedTools,
    disallowedTools: role.disallowedTools ?? def?.disallowedTools ?? config.disallowedTools,
  }
}

async function ensureGitignore($: EngineInterface) {
  if (isGitignoreChecked || !config.gitignore) return
  isGitignoreChecked = true
  const entry = `${config.relayDir.replace(/\\/g, '/').replace(/\/+$/, '')}/runs/`
  try {
    if (await $.fs.exists('.gitignore')) {
      const text = await $.fs.read('.gitignore')
      if (!text.split(/\r?\n/).some(l => l.trim() === entry)) {
        await $.fs.write('.gitignore', `${text}${text.endsWith('\n') || !text ? '' : '\n'}${entry}\n`)
      }
    } else if (await $.fs.exists('.git')) {
      await $.fs.write('.gitignore', `${entry}\n`)
    }
  } catch {
    // not worth failing a run over
  }
}

// Starts queued jobs while there is room and their role is idle.
async function pump($: EngineInterface) {
  while (running < Math.max(1, config.maxParallel)) {
    const index = queue.findIndex(j => !roles[j.role]?.isBusy)
    if (index < 0) break
    const [job] = queue.splice(index, 1)
    if (job) await start($, job)
  }
  showStatus($)
}

async function start($: EngineInterface, job: Job) {
  const role = roles[job.role]
  if (!role) return
  const eff = effective(role, (await loadRoleDefs($))[role.name])
  const isNew = role.sessionId === undefined
  const sessionId = role.sessionId ?? crypto.randomUUID()
  const run = role.runs + 1
  const model = job.model || eff.model
  const argv = [
    config.claudeBin,
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    config.permissionMode,
    '--append-system-prompt',
    protocolPrompt(role.name, eff.brief, eff.owns),
    ...(isNew ? ['--session-id', sessionId] : ['--resume', sessionId]),
    ...(model ? ['--model', model] : []),
    ...(eff.effort ? ['--effort', eff.effort] : []),
    ...(config.maxBudgetUsd > 0 ? ['--max-budget-usd', String(config.maxBudgetUsd)] : []),
    ...(eff.allowedTools.length ? ['--allowedTools', ...eff.allowedTools] : []),
    ...(eff.disallowedTools.length ? ['--disallowedTools', ...eff.disallowedTools] : []),
  ]
  const env: Record<string, string> = { RELAY_WORKER: '1', RELAY_CWD: cwd }
  if (config.enforceOwns && eff.owns.length) env.RELAY_OWNS = JSON.stringify(eff.owns)

  role.isBusy = true
  role.runs = run
  role.sessionId = sessionId
  running++
  await save($)
  showStatus($)

  // The child outlives the tool call that queued it: this loop runs on.
  void (async () => {
    let stdout = ''
    let stderr = ''
    let isTimedOut = false
    const child = $.process.spawn({ argv, cwd, input: job.task, env })
    const timer =
      config.runTimeoutMin > 0
        ? $.clock.after(config.runTimeoutMin * 60_000, () => {
            isTimedOut = true
            void child.return(undefined as never)
          })
        : undefined
    try {
      for await (const chunk of child) {
        if (chunk.stream === 'stdout') stdout += chunk.text
        else stderr += chunk.text
      }
    } catch (err) {
      stderr += `\n${String(err)}`
    }
    timer?.cancel()
    running--
    try {
      await finish($, role, run, job.task, stdout, stderr, isTimedOut)
    } finally {
      await pump($)
    }
  })()
}

async function finish(
  $: EngineInterface,
  role: Role,
  run: number,
  task: string,
  stdout: string,
  stderr: string,
  isTimedOut: boolean,
) {
  let answer = ''
  let meta = ''
  try {
    const json = JSON.parse(stdout) as {
      result?: string
      is_error?: boolean
      subtype?: string
      session_id?: string
      num_turns?: number
      total_cost_usd?: number
    }
    answer = json.result ?? ''
    if (json.session_id) role.sessionId = json.session_id
    meta = [
      json.num_turns !== undefined ? `${json.num_turns} turns` : '',
      json.total_cost_usd !== undefined ? `$${json.total_cost_usd.toFixed(2)}` : '',
      json.is_error ? `worker error${json.subtype ? ` (${json.subtype})` : ''}` : '',
    ]
      .filter(Boolean)
      .join(', ')
  } catch {
    answer = stdout
  }
  if (isTimedOut) meta = [meta, `stopped after ${config.runTimeoutMin} min`].filter(Boolean).join(', ')

  let packet = parsePacket(answer)
  if (packet) packet.compressed_by = 'worker'
  else if (answer.trim() && config.fallbackCompress) {
    const compressed = await $.model.complete({ model: config.fallbackModel, system: fallbackPrompt(role.name), prompt: answer })
    packet = compressed.isAnswered ? parsePacket(compressed.text) : undefined
    if (packet) packet.compressed_by = 'fallback'
  }
  packet ??= {
    status: 'failed',
    summary: isTimedOut
      ? `Worker was stopped after ${config.runTimeoutMin} minutes without a packet.`
      : answer.trim()
        ? 'Worker answered without a relay packet (fallback compression is off); read the full text.'
        : `Worker produced no usable answer.${stderr.trim() ? ` stderr: ${stderr.trim().slice(0, 500)}` : ''}`,
    decisions: [],
    facts: [],
    artifacts: [],
    open_questions: [],
    needs_from_main: [],
    risks: [],
    next_suggested: [],
    sections: [],
    compressed_by: 'none',
  }
  if (isTimedOut && packet.status === 'done') packet.status = 'partial'

  await ensureGitignore($)
  const fullPath = runPath(role.name, run, 'full.md')
  await $.fs.write(fullPath, `# ${role.name} · run ${run}\n\n## Task\n\n${task}\n\n## Answer\n\n${stripPacket(answer)}\n`)
  await $.fs.write(runPath(role.name, run, 'packet.json'), JSON.stringify({ run, ...packet }, null, 2))

  role.isBusy = false
  role.lastStatus = packet.status
  role.lastSummary = packet.summary
  roles[role.name] = role
  await save($)

  const head = `[relay] ${role.name} · run ${run} finished${meta ? ` (${meta})` : ''}`
  const text = renderPacket(head, packet, fullPath, config.packetDetail)
  if (config.notifyMode === 'note') {
    await $.session.append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    $.ui.toast(`relay: ${role.name} run ${run} ${packet.status}`)
  } else if (config.notifyMode === 'toast') {
    unread.push(text)
    $.ui.toast(`relay: ${role.name} run ${run} ${packet.status} – worker_status shows it`)
  } else {
    await $.prompt.submit({ text })
  }
}

// A worker may only write what it owns, when the main agent asked for that.
function denyUnowned(path: string | undefined) {
  const reason = ownershipDenial(path, workerCwd, workerOwns)
  return reason ? { deny: `relay: ${reason}` } : undefined
}

export const register: Register = (on, options) => {
  const str = (k: string, d: string) => (typeof options[k] === 'string' ? String(options[k]) : d)
  const num = (k: string, d: number) => (typeof options[k] === 'number' ? Number(options[k]) : d)
  const bool = (k: string, d: boolean) => (typeof options[k] === 'boolean' ? Boolean(options[k]) : d)
  config.claudeBin = str('claudeBin', config.claudeBin)
  config.permissionMode = str('permissionMode', config.permissionMode)
  config.workerModel = str('workerModel', config.workerModel).trim()
  config.workerEffort = str('workerEffort', config.workerEffort)
  config.maxBudgetUsd = num('maxBudgetUsd', config.maxBudgetUsd)
  config.maxParallel = num('maxParallel', config.maxParallel)
  config.runTimeoutMin = num('runTimeoutMin', config.runTimeoutMin)
  config.allowedTools = toList(options.allowedTools)
  config.disallowedTools = toList(options.disallowedTools)
  config.enforceOwns = bool('enforceOwns', config.enforceOwns)
  config.notifyMode = str('notifyMode', config.notifyMode)
  config.packetDetail = str('packetDetail', config.packetDetail) === 'lean' ? 'lean' : 'full'
  config.fallbackCompress = bool('fallbackCompress', config.fallbackCompress)
  config.fallbackModel = str('fallbackModel', config.fallbackModel)
  config.relayDir = str('relayDir', config.relayDir).trim() || '.relay'
  config.rolesFile = str('rolesFile', config.rolesFile).trim() || `${config.relayDir}/roles.json`
  config.gitignore = bool('gitignore', config.gitignore)
  config.keepRuns = num('keepRuns', config.keepRuns)

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    // A worker session must not become an orchestrator itself; it only
    // carries the ownership guard.
    if ((await $.env.get('RELAY_WORKER')) === '1') {
      workerCwd = (await $.env.get('RELAY_CWD')) ?? e.cwd
      try {
        workerOwns = toList(JSON.parse((await $.env.get('RELAY_OWNS')) ?? '[]'))
      } catch {
        workerOwns = []
      }
      return started
    }
    cwd = e.cwd
    roles = ((await $.store.get(storeKey())) as Record<string, Role> | undefined) ?? {}
    // Children die with the module: a role still marked busy is stale.
    for (const r of Object.values(roles)) r.isBusy = false
    queue = []
    running = 0
    await save($)

    await $.tool.register({
      name: 'worker_send',
      isDeferred: false,
      description:
        'Send a task to a persistent worker session (its own Claude Code session, started via CLI). ' +
        'Returns immediately; the worker runs in the background (or waits in the queue) and its compact relay packet arrives later. ' +
        'The same role keeps its context across tasks unless fresh is true. Roles may be predefined in the roles file; ' +
        'brief/owns/model/effort/tools given here are stored for the role and win over the file.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string', description: 'Role name, e.g. ingester, architect, researcher (lowercase).' },
          task: { type: 'string', description: 'The task, self-contained: what to do and what done looks like.' },
          brief: { type: 'string', description: 'Standing role description; stored.' },
          owns: { type: 'array', items: { type: 'string' }, description: 'Paths this role may write; stored and enforced.' },
          model: { type: 'string', description: 'Model for this role; stored.' },
          effort: { type: 'string', enum: ['default', 'low', 'medium', 'high', 'xhigh', 'max'], description: 'Effort for this role; stored.' },
          allowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool rules allowed without asking; stored.' },
          disallowedTools: { type: 'array', items: { type: 'string' }, description: 'Tool rules the role may never use; stored.' },
          fresh: { type: 'boolean', description: 'Start a new worker session, dropping the old context.' },
        },
        required: ['role', 'task'],
      },
    })
    await $.tool.register({
      name: 'worker_status',
      isDeferred: false,
      description:
        'List worker roles (stored and from the roles file): working, queued or idle, runs, last status. ' +
        'Also returns packets that arrived unread (notify mode "toast").',
      inputSchema: { type: 'object', properties: {} },
    })
    await $.tool.register({
      name: 'worker_expand',
      isDeferred: false,
      description:
        "Fetch details behind a relay packet: one section of a worker run's full answer by heading, " +
        'section "packet" for the complete packet, or the whole answer. Prefer a section; the full text costs context.',
      inputSchema: {
        type: 'object',
        properties: {
          role: { type: 'string' },
          run: { type: 'number', description: 'Run number; latest when absent.' },
          section: { type: 'string', description: 'Heading to fetch (as listed under sections), or "packet".' },
          maxChars: { type: 'number', description: 'Cut-off, default 12000.' },
        },
        required: ['role'],
      },
    })
    showStatus($)
    return started
  })

  on('tool.call', { tool: 'Edit' }, ($, e, next) => denyUnowned(e.file_path) ?? next(e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'relay: the ownership guard failed.' },
  )
  on('tool.call', { tool: 'Write' }, ($, e, next) => denyUnowned(e.file_path) ?? next(e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'relay: the ownership guard failed.' },
  )
  on('tool.call', { tool: 'NotebookEdit' }, ($, e, next) => denyUnowned(e.notebook_path) ?? next(e)).catch(($, e, next) =>
    next.called ? next(e) : { deny: 'relay: the ownership guard failed.' },
  )

  on('tool.call', { tool: 'mcp__relay__worker_status' }, async $ => {
    const defs = await loadRoleDefs($)
    const names = [...new Set([...Object.keys(roles), ...Object.keys(defs)])].sort()
    const lines = names.map(name => {
      const r = roles[name]
      const eff = effective(r ?? { name, runs: 0, isBusy: false }, defs[name])
      const queued = queue.filter(j => j.role === name).length
      const state = r?.isBusy ? 'working' : queued ? 'queued' : r ? 'idle' : 'defined, never run'
      return (
        `${name}: ${state}${queued ? ` (${queued} waiting)` : ''}, ${r?.runs ?? 0} run(s)` +
        (r?.lastStatus ? `, last ${r.lastStatus}: ${r.lastSummary ?? ''}` : '') +
        (eff.owns.length ? ` · owns ${eff.owns.join(', ')}` : '') +
        (eff.model ? ` · ${eff.model}` : '')
      )
    })
    const out = [
      lines.length ? lines.join('\n') : 'No worker roles yet. Create one with worker_send or in the roles file.',
      `Running ${running}/${Math.max(1, config.maxParallel)}, queued ${queue.length}.`,
    ]
    if (unread.length) {
      out.push('', `Unread packets (${unread.length}):`, '', unread.join('\n\n'))
      unread = []
    }
    return { result: out.join('\n') }
  })

  on('tool.call', { tool: 'mcp__relay__worker_expand' }, async ($, e) => {
    const input = e as unknown as { role: string; run?: number; section?: string; maxChars?: number }
    const role = roles[input.role]
    if (!role || role.runs === 0) return { result: `No runs for role "${input.role}".` }
    const run = input.run ?? (role.isBusy ? role.runs - 1 : role.runs)
    if (run < 1) return { result: `${role.name} has no finished run yet.` }
    if (isRotatedOut(role, run)) return { result: `${role.name} run ${run} was rotated out (keepRuns ${config.keepRuns}).` }
    if (input.section?.trim().toLowerCase() === 'packet') {
      try {
        const packet = parsePacket(await $.fs.read(runPath(role.name, run, 'packet.json')))
        if (packet) return { result: renderPacket(`[relay] ${role.name} · run ${run}`, packet, runPath(role.name, run, 'full.md'), 'full') }
      } catch {
        // fall through
      }
      return { result: `No stored packet for ${role.name} run ${run}.` }
    }
    let text: string
    try {
      text = await $.fs.read(runPath(role.name, run, 'full.md'))
    } catch {
      return { result: `No stored answer for ${role.name} run ${run}.` }
    }
    let out = text
    if (input.section) {
      const found = extractSection(text, input.section)
      if (!found) return { result: `No section "${input.section}" in ${role.name} run ${run}.` }
      out = found
    }
    const max = input.maxChars ?? 12000
    return { result: out.length > max ? `${out.slice(0, max)}\n… [cut at ${max} of ${out.length} chars]` : out }
  })

  on('tool.call', { tool: 'mcp__relay__worker_send' }, async ($, e) => {
    const input = e as unknown as {
      role: string
      task: string
      brief?: string
      owns?: string[]
      model?: string
      effort?: string
      allowedTools?: string[]
      disallowedTools?: string[]
      fresh?: boolean
    }
    const name = input.role.trim().toLowerCase()
    if (!ROLE_NAME.test(name)) return { result: `Invalid role name "${input.role}": use a-z, 0-9, - and _.` }
    const role: Role = roles[name] ?? { name, runs: 0, isBusy: false }
    if (input.brief !== undefined) role.brief = input.brief
    if (input.owns !== undefined) role.owns = toList(input.owns)
    if (input.model !== undefined) role.model = input.model
    if (input.effort !== undefined) role.effort = input.effort
    if (input.allowedTools !== undefined) role.allowedTools = toList(input.allowedTools)
    if (input.disallowedTools !== undefined) role.disallowedTools = toList(input.disallowedTools)
    if (input.fresh) {
      if (role.isBusy || queue.some(j => j.role === name)) return { result: `${name} has work in flight; fresh is only possible when it is idle.` }
      role.sessionId = undefined
    }
    roles[name] = role
    await save($)

    queue.push({ role: name, task: input.task })
    const before = running
    await pump($)
    const isStarted = running > before && role.isBusy && !queue.some(j => j.role === name)
    return {
      result: isStarted
        ? `${name} run ${role.runs} started. Its relay packet will arrive later (${config.notifyMode}); continue with other work.`
        : `${name}: task queued (position ${queue.findIndex(j => j.role === name) + 1} of ${queue.length}; ` +
          `${role.isBusy ? 'the role is still working' : `all ${config.maxParallel} slots are busy`}).`,
    }
  })
}
