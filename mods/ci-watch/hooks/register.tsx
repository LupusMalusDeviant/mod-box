// CI watch: "A push you don't check on doesn't count as done."
// After every successful `git push` (Bash tool) it polls the GitHub Actions runs for the
// pushed commit via gh until all are done. A band above the prompt shows the status;
// on red it fetches `gh run view --log-failed`, opens a window with the log and/or puts
// an analysis request into the prompt (nothing is sent by itself). /ci shows the status.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { CiRun, CiWatch } from '../types'
import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'

const watch = atom({ plugin: 'mod-box', key: 'ci_watch' } as const, null as CiWatch | null)
const PANE = 'ci-watch'
const NO_RUNS_AFTER_MS = 120_000 // how long GitHub may take to create a run
const GIVE_UP_AFTER_MS = 3 * 60 * 60_000
const LOG_LINES = 200

export const PUSH = /(?:^|[;&|(]\s*)git\s+(?:-C\s+(\S+)\s+)?push\b/

// Settings and timers at module level: the validator requires $ to be passed only to
// top-level functions.
let intervalMs = 20_000
let onRed = 'both'
let withSound = false
let notifyOn = 'red'
let prOnDesktop = 'app'
let onDesktop = false

export const PR_CREATE = /(?:^|[;&|(]\s*)gh\s+pr\s+create\b/
export const PR_URL = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/
// Display language (options.language: de | en)
let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
let timer: Timer | null = null

function stop() {
  timer?.cancel()
  timer = null
}

function start($: EngineInterface) {
  stop()
  timer = $.clock.every(intervalMs, () => void poll($).catch(() => {}))
  void poll($).catch(() => {})
}

async function poll($: EngineInterface) {
  const w = await read($, watch)
  if (!w || (w.phase !== 'warte' && w.phase !== 'laeuft')) return stop()
  const now = await $.clock.now()
  const fetched = w.pr ? await prChecks($, w) : await commitRuns($, w)
  if (typeof fetched === 'string') {
    await set($, x => ({ ...x, phase: 'fehler', message: fetched, endedAt: now }))
    return stop()
  }
  const runs = fetched
  if (runs.length === 0) {
    if (now - w.startedAt > NO_RUNS_AFTER_MS) {
      await set($, x => ({ ...x, phase: 'keine', message: t('Kein Actions-Lauf zu diesem Commit.', 'No Actions run for this commit.'), endedAt: now }))
      stop()
    }
    return
  }
  const open = runs.filter(x => x.status !== 'completed')
  if (open.length > 0) {
    await set($, x => ({ ...x, phase: 'laeuft', runs }))
    if (now - w.startedAt > GIVE_UP_AFTER_MS) {
      await set($, x => ({ ...x, phase: 'fehler', message: t('Nach 3 Stunden nicht fertig; Überwachung beendet.', 'Not finished after 3 hours; stopped watching.'), endedAt: now }))
      stop()
    }
    return
  }
  const bad = runs.find(x => !['success', 'skipped', 'neutral'].includes(x.conclusion))
  stop()
  if (!bad) {
    const merge = w.pr ? await mergeState($, w) : ''
    await set($, x => ({ ...x, phase: 'gruen', runs, endedAt: now, message: '', pr: x.pr ? { ...x.pr, merge } : null }))
    $.ui.toast(
      w.pr
        ? t(`PR #${w.pr.number}: alle ${runs.length} Checks grün${merge ? ` · ${merge}` : ''}`, `PR #${w.pr.number}: all ${runs.length} checks green${merge ? ` · ${merge}` : ''}`)
        : t(`CI grün: ${runs.length} Lauf/Läufe für ${w.sha.slice(0, 7)}`, `CI green: ${runs.length} run(s) for ${w.sha.slice(0, 7)}`),
    )
    void sound($, 'green')
    void notify($, 'green', w.pr ? `PR #${w.pr.number}: ${t('alle Checks grün', 'all checks green')}` : `${w.branch} ${w.sha.slice(0, 7)}: ${t('alle Läufe grün', 'all runs green')}`)
    return
  }
  const log = bad.id ? await $.process.run(['gh', 'run', 'view', String(bad.id), '--log-failed'], { cwd: w.cwd, timeoutMs: 60_000 }).catch(() => null) : null
  const tail = (log?.stdout ?? '').split('\n').slice(-LOG_LINES).join('\n').trim()
  const noLog = bad.id
    ? t('(kein Log erhalten)', '(no log received)')
    : t(`(Check außerhalb von GitHub Actions: kein Log über gh. Details: ${bad.url})`, `(check outside GitHub Actions: no log through gh. Details: ${bad.url})`)
  await set($, x => ({ ...x, phase: 'rot', runs, endedAt: now, failed: { id: bad.id, name: bad.name, url: bad.url, log: tail || noLog } }))
  void sound($, 'red')
  void notify($, 'red', `${bad.name} (${bad.conclusion}) · ${w.pr ? `PR #${w.pr.number}` : w.branch}`)
  $.ui.toast(t(`CI rot: ${bad.name} (${bad.conclusion}). Analysieren, bevor irgendetwas anderes passiert.`, `CI red: ${bad.name} (${bad.conclusion}). Analyse it before anything else happens.`))
  if (onRed === 'pane' || onRed === 'both') void $.ui.open({ id: PANE, title: `${t('CI rot', 'CI red')} · ${bad.name}`, focus: true, closeOnEscape: true }).catch(() => {})
  if (onRed === 'prompt' || onRed === 'both') void $.prompt.fill({ text: analyse(w, bad), mode: 'replace' }).catch(() => {})
}

async function startAfterPush($: EngineInterface, dashC: string | undefined, command: string) {
  if (await begin($, dashC, command)) start($)
}

function ghError(stderr: string): string {
  return /not found|nicht gefunden|ENOENT|cannot find/i.test(stderr)
    ? t('gh ist nicht installiert.', 'gh is not installed.')
    : /auth|login/i.test(stderr)
      ? t('gh ist nicht angemeldet (gh auth login).', 'gh is not signed in (gh auth login).')
      : stderr.trim().split('\n')[0] || t('gh-Fehler', 'gh error')
}

// The Actions runs of the pushed commit; a message when gh fails.
async function commitRuns($: EngineInterface, w: CiWatch): Promise<CiRun[] | string> {
  const r = await $.process
    .run(['gh', 'run', 'list', '--commit', w.sha, '--json', 'databaseId,name,workflowName,status,conclusion,url', '--limit', '30'], { cwd: w.cwd, timeoutMs: 30_000 })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (r.exitCode !== 0) return ghError(r.stderr)
  return (JSON.parse(r.stdout || '[]') as Array<Record<string, unknown>>).map(x => ({
    id: Number(x.databaseId),
    name: String(x.workflowName || x.name || 'Lauf'),
    status: String(x.status ?? ''),
    conclusion: String(x.conclusion ?? ''),
    url: String(x.url ?? ''),
  }))
}

/** gh pr checks --json: bucket pass|fail|pending|skipping|cancel; exit 8 while pending, 1 on failure. */
export function parseChecks(stdout: string): CiRun[] {
  const list = JSON.parse(stdout || '[]') as Array<Record<string, unknown>>
  return list.map(x => {
    const bucket = String(x.bucket ?? '')
    const link = String(x.link ?? '')
    const run = /\/actions\/runs\/(\d+)/.exec(link)
    return {
      id: run ? Number(run[1]) : 0,
      name: x.workflow ? `${String(x.workflow)} / ${String(x.name ?? '')}` : String(x.name ?? 'Check'),
      status: bucket === 'pending' ? 'in_progress' : 'completed',
      conclusion: bucket === 'pass' ? 'success' : bucket === 'skipping' ? 'skipped' : bucket === 'fail' ? 'failure' : bucket === 'cancel' ? 'cancelled' : bucket,
      url: link,
    }
  })
}

// The checks of a pull request: Actions and every other check (other CI, bots).
async function prChecks($: EngineInterface, w: CiWatch): Promise<CiRun[] | string> {
  const r = await $.process
    .run(['gh', 'pr', 'checks', String(w.pr!.number), '--json', 'name,state,bucket,link,workflow'], { cwd: w.cwd, timeoutMs: 30_000 })
    .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  if (r.stdout.trim().startsWith('[')) return parseChecks(r.stdout)
  if (/no checks reported/i.test(r.stderr)) return []
  return ghError(r.stderr)
}

// After green: can the PR be merged? (mergeStateStatus and reviewDecision of gh pr view)
async function mergeState($: EngineInterface, w: CiWatch): Promise<string> {
  const r = await $.process
    .run(['gh', 'pr', 'view', String(w.pr!.number), '--json', 'mergeStateStatus,reviewDecision,isDraft,state'], { cwd: w.cwd, timeoutMs: 30_000 })
    .catch(() => null)
  if (!r || r.exitCode !== 0) return ''
  return mergeText(JSON.parse(r.stdout || '{}'))
}

export function mergeText(v: { mergeStateStatus?: string; reviewDecision?: string; isDraft?: boolean; state?: string }): string {
  if (v.state && v.state !== 'OPEN') return v.state === 'MERGED' ? t('schon gemergt', 'already merged') : t('geschlossen', 'closed')
  if (v.isDraft) return t('noch Entwurf', 'still a draft')
  if (v.reviewDecision === 'CHANGES_REQUESTED') return t('Änderungen angefordert', 'changes requested')
  if (v.reviewDecision === 'REVIEW_REQUIRED') return t('wartet auf Review', 'waiting for review')
  switch (v.mergeStateStatus) {
    case 'CLEAN':
    case 'HAS_HOOKS':
      return t('bereit zum Mergen', 'ready to merge')
    case 'DIRTY':
      return t('Merge-Konflikte', 'merge conflicts')
    case 'BEHIND':
      return t('Branch ist hinter der Basis', 'branch is behind its base')
    case 'BLOCKED':
      return t('blockiert (Regeln des Repos)', 'blocked (repo rules)')
    case 'UNSTABLE':
      return t('nicht alle Pflicht-Checks grün', 'not all required checks green')
    default:
      return ''
  }
}

// Starts watching a pull request: its number or URL, in the folder cwd.
async function beginPr($: EngineInterface, ref: string, cwd: string): Promise<boolean> {
  // No ref: the pull request of the current branch.
  const r = await $.process.run(['gh', 'pr', 'view', ...(ref ? [ref] : []), '--json', 'number,url,title,headRefName,headRefOid,state'], { cwd, timeoutMs: 30_000 }).catch(() => null)
  if (!r || r.exitCode !== 0) return false
  const v = JSON.parse(r.stdout || '{}') as { number?: number; url?: string; title?: string; headRefName?: string; headRefOid?: string; state?: string }
  if (!v.number || v.state !== 'OPEN') return false
  const now = await $.clock.now()
  await update($, watch, (): CiWatch => ({
    sha: String(v.headRefOid ?? ''),
    branch: String(v.headRefName ?? '?'),
    cwd,
    startedAt: now,
    endedAt: 0,
    phase: 'warte',
    runs: [],
    failed: null,
    message: '',
    isDismissed: false,
    pr: { number: Number(v.number), url: String(v.url ?? ''), title: String(v.title ?? ''), merge: '' },
  }))
  return true
}

async function startPr($: EngineInterface, ref: string, cwd: string): Promise<boolean> {
  const ok = await beginPr($, ref, cwd)
  if (ok) start($)
  return ok
}

// A system notification at the end (option notify: off | red | always), through the person's own
// notification channel. Claude Code notifies when a turn ends; a CI run usually ends later.
async function notify($: EngineInterface, kind: 'green' | 'red', text: string) {
  if (notifyOn === 'off' || (notifyOn === 'red' && kind === 'green')) return
  await $.ui.notify(text, { title: kind === 'red' ? t('CI rot', 'CI red') : t('CI grün', 'CI green') }).catch(() => undefined)
}

// A short sound at the end (option): Windows system sounds through PowerShell, elsewhere the mod's own clip.
async function sound($: EngineInterface, kind: 'green' | 'red') {
  if (!withSound) return
  if ((await $.env.get('OS')) === 'Windows_NT') {
    const s = kind === 'green' ? 'Asterisk' : 'Hand'
    await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `[System.Media.SystemSounds]::${s}.Play(); Start-Sleep -Milliseconds 900`], { timeoutMs: 10_000 }).catch(() => {})
  } else {
    await $.audio.play({ asset: `mods/ci-watch/sounds/${kind}.wav` }).catch(() => {})
  }
}

export const register: Register = (on, options) => {
  // Band manager: hand this mod’s display to the Mod Box (it draws, orders and places it).
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!e.props.hasSurvey) {
      const part = await band($, e).catch(() => null)
      if (part) offerBand(e, part)
    }
    return rest
  })

  intervalMs = Math.max(5, Number(options.intervalSec) || 20) * 1000
  onRed = String(options.onRed || 'both')
  withSound = options.sound === 'on'
  notifyOn = String(options.notify || 'red')
  prOnDesktop = String(options.prOnDesktop || 'app')
  lang = options.language === 'de' ? 'de' : 'en'

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    onDesktop = (e as { surface?: string | null }).surface === 'desktop'
    await $.command.register({
      name: 'ci',
      description: t('CI-Wächter: Stand der Läufe zum letzten Push oder PR', 'CI Watch: state of the runs for the last push or PR'),
      argumentHint: '[pr <nr|url> | stop]',
    })
    // Watching continues after a reload.
    const w = await read($, watch)
    if (w && (w.phase === 'warte' || w.phase === 'laeuft')) start($)
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const result = await next(e)
    if (('deny' in result && result.deny !== undefined) || result.isError) return result
    const cmd = String(e.command ?? '')
    // A new pull request: its URL stands in the output of gh pr create.
    if (PR_CREATE.test(cmd)) {
      const url = PR_URL.exec(String(result.text ?? ''))?.[0]
      // The desktop app binds a new PR to the session and watches its checks itself (CI bar, auto-fix).
      if (url && onDesktop && prOnDesktop === 'app') $.ui.toast(t('PR-Checks überwacht die Desktop-App (CI-Leiste); /ci pr zeigt sie hier.', 'The desktop app watches the PR checks (CI bar); /ci pr shows them here.'))
      else if (url) void startPr($, url, await $.session.cwd()).catch(() => {})
      return result
    }
    const m = PUSH.exec(cmd)
    if (!m) return result
    if (/\bpush\b[^;&|]*(?:--dry-run|\s-n\b)/.test(cmd)) return result
    void startAfterPush($, m[1], cmd).catch(() => {})
    return result
  })

  on('command.run', { command: 'ci' }, async ($, e) => {
    const args = String(e.args ?? '').trim().split(/\s+/).filter(Boolean)
    if (args[0] === 'stop') {
      stop()
      await update($, watch, () => null)
      return { text: t('CI-Wächter: Beobachtung beendet.', 'CI Watch: stopped watching.') }
    }
    if (args[0] === 'pr') {
      const ref = args[1] ?? ''
      const ok = ref ? await startPr($, ref, await $.session.cwd()) : await startPr($, '', await $.session.cwd())
      return {
        text: ok
          ? t(`CI-Wächter: beobachte PR ${ref || '(Branch)'}.`, `CI Watch: watching PR ${ref || '(branch)'}.`)
          : t('CI-Wächter: kein offener PR gefunden (/ci pr <Nummer oder URL>).', 'CI Watch: no open PR found (/ci pr <number or URL>).'),
      }
    }
    const w = await read($, watch)
    if (!w) return { text: t('CI-Wächter: noch kein Push in dieser Sitzung. /ci pr <Nummer> beobachtet einen PR.', 'CI Watch: no push in this session yet. /ci pr <number> watches a PR.') }
    if (w.phase === 'rot') await $.ui.open({ id: PANE, title: `${t('CI rot', 'CI red')} · ${w.failed?.name ?? ''}`, focus: true, closeOnEscape: true })
    await update($, watch, x => (x ? { ...x, isDismissed: false } : x))
    return { text: `${t('CI-Wächter', 'CI Watch')}: ${summary(w)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Code } = $.ui.resolve(e) as any
    const w = await read($, watch)
    const f = w?.failed
    if (!w || !f) return <Text dimColor>{t('Kein roter Lauf.', 'No red run.')}</Text>
    const rows = Math.max(5, (e.viewport?.rows ?? 30) - 8)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text>
          <Text color="red" bold>{`✘ ${f.name}`}</Text>
          <Text dimColor>{w.pr ? `  ·  PR #${w.pr.number} ${w.pr.title}` : `  ·  ${w.branch}@${w.sha.slice(0, 7)}`}</Text>
        </Text>
        <Text dimColor>{f.url}</Text>
        <Box marginTop={1} flexDirection="column">
          {Code ? <Code source={f.log.split('\n').slice(-rows).join('\n')} wrap="truncate-end" /> : <Text>{f.log.split('\n').slice(-rows).join('\n')}</Text>}
        </Box>
        <Box flexDirection="row" marginTop={1}>
          <Button key="ci-p-analyse" label={t('Analysieren lassen', 'Have it analysed')} variant="primary" autoFocus onPress={() => void $.prompt.fill({ text: analyse(w, f), mode: 'replace' }).then(() => $.ui.close({ id: PANE }))} />
          <Text>{'  '}</Text>
          <Button key="ci-p-kopieren" label={t('Log kopieren', 'Copy log')} onPress={(press: { surface?: string }) => void $.ui.copy({ text: f.log, surface: press.surface as any })} />
          <Text>{'  '}</Text>
          <Button key="ci-p-zu" label={t('Schließen', 'Close')} role="dismiss" onPress={() => void $.ui.close({ id: PANE })} />
        </Box>
      </Box>
    )
  })
}

async function set($: EngineInterface, fn: (w: CiWatch) => CiWatch) {
  await update($, watch, w => (w ? fn(w) : w))
}

async function begin($: EngineInterface, dashC: string | undefined, command: string): Promise<boolean> {
  const base = await $.session.cwd()
  const cd = /(?:^|[;&|]\s*)cd\s+("[^"]+"|'[^']+'|\S+)\s*&&[^;|]*git\s+(?:-C\s+\S+\s+)?push/.exec(command)?.[1]?.replace(/^["']|["']$/g, '')
  const dir = dashC ?? cd
  const cwd = dir ? (/^([a-zA-Z]:[\\/]|\/)/.test(dir) ? dir : `${base}/${dir}`) : base
  const head = await $.process.run(['git', 'rev-parse', 'HEAD'], { cwd }).catch(() => null)
  if (!head || head.exitCode !== 0) return false
  const branch = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd }).catch(() => null)
  // Has the branch an open pull request? Then its checks count (also other CI and bots).
  if (await beginPr($, branch?.stdout.trim() || '', cwd)) return true
  const now = await $.clock.now()
  await update($, watch, (): CiWatch => ({
    sha: head.stdout.trim(),
    branch: branch?.stdout.trim() || '?',
    cwd,
    startedAt: now,
    endedAt: 0,
    phase: 'warte',
    runs: [],
    failed: null,
    message: '',
    isDismissed: false,
    pr: null,
  }))
  return true
}

export function summary(w: CiWatch): string {
  const ref = w.pr ? `PR #${w.pr.number}` : `${w.branch}@${w.sha.slice(0, 7)}`
  const took = w.endedAt && w.startedAt ? ` in ${fmt(w.endedAt - w.startedAt)}` : ''
  switch (w.phase) {
    case 'warte':
      return `${ref}: ${t('warte auf GitHub Actions …', 'waiting for GitHub Actions …')}`
    case 'laeuft': {
      const done = w.runs.filter(r => r.status === 'completed').length
      return `${ref}: ${t(`${w.runs.length - done} laufen, ${done} fertig`, `${w.runs.length - done} running, ${done} done`)} (${w.runs.map(r => r.name).join(', ')})`
    }
    case 'gruen':
      return w.pr
        ? `${ref}: ${t(`${w.runs.length} Checks grün`, `${w.runs.length} checks green`)}${took}${w.pr.merge ? ` · ${w.pr.merge}` : ''}`
        : `${ref}: ${t(`grün, ${w.runs.length} Lauf/Läufe`, `green, ${w.runs.length} run(s)`)}${took}`
    case 'rot':
      return `${ref}: ${t('rot in', 'red in')} ${w.failed?.name ?? '?'}${took}`
    case 'keine':
      return `${ref}: ${w.message}`
    case 'fehler':
      return `${ref}: ${w.message}`
  }
}

function fmt(ms: number): string {
  const s = Math.round(ms / 1000)
  return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`
}

// The request Claude gets is English; only the answer follows the language setting.
export function analyse(w: CiWatch, f: { id: number; name: string; url: string }): string {
  const what = w.pr ? `PR #${w.pr.number} (${w.pr.url})` : `${w.branch}@${w.sha.slice(0, 7)}`
  const answerIn = lang === 'en' ? '' : ' Answer in German.'
  if (!f.id) {
    // A check outside GitHub Actions: no log through gh, only its link.
    return `CI is red for ${what}: check "${f.name}" (${f.url}) failed; it does not run in GitHub Actions. Open its details, name the cause and whether it lies in the code, in the setup or in something external, then propose the fix before anything else happens.${answerIn}`
  }
  return (
    `CI is red: run "${f.name}" for ${w.branch}@${w.sha.slice(0, 7)} (${f.url}). ` +
    `Read the logs of the failed step (gh run view ${f.id} --log-failed), name the cause ` +
    'and say whether it lies in the code, in the fixture or in something external. If external: should the test withstand it? ' +
    `Then propose the fix, before anything else happens.${answerIn}`
  )
}

// For the Mod Box band manager (instead of an AbovePrompt hook of its own).
export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  const w = await read($, watch)
  if (!w || w.isDismissed) return null
  const { Text, Button } = $.ui.resolve(e)
  const color = w.phase === 'gruen' ? 'green' : w.phase === 'rot' ? 'red' : w.phase === 'fehler' ? 'yellow' : 'cyan'
  const icon = w.phase === 'gruen' ? '✔' : w.phase === 'rot' ? '✘' : w.phase === 'fehler' || w.phase === 'keine' ? '·' : '⏳'
  const isDone = w.phase !== 'warte' && w.phase !== 'laeuft'
  const actions: unknown[] = []
  if (w.phase === 'rot') {
    actions.push(<Button key="ci-log" label="Log" plain onPress={() => void $.ui.open({ id: PANE, title: `${t('CI rot', 'CI red')} · ${w.failed?.name ?? ''}`, focus: true, closeOnEscape: true })} />)
    if (w.failed) actions.push(<Button key="ci-analyse" label={t('Analysieren', 'Analyse')} plain onPress={() => void $.prompt.fill({ text: analyse(w, w.failed!), mode: 'replace' })} />)
  }
  if (isDone) actions.push(<Button key="ci-weg" label="×" plain onPress={() => void update($, watch, x => (x ? { ...x, isDismissed: true } : x))} />)
  return {
    id: 'ciWatch',
    urgent: w.phase === 'rot' || w.phase === 'fehler',
    short: (
      <Text>
        <Text color={color} bold>{`CI ${icon}`}</Text>
        <Text dimColor>{` ${w.pr ? `#${w.pr.number} ` : ''}${w.phase === 'laeuft' ? `${w.runs.filter(r => r.status === 'completed').length}/${w.runs.length}` : w.phase === 'gruen' ? (w.pr?.merge || t('grün', 'green')) : w.phase === 'warte' ? '…' : w.pr ? '' : w.branch}`}</Text>
      </Text>
    ),
    line: (
      <Text>
        <Text color={color} bold>{`CI ${icon} `}</Text>
        <Text>{summary(w)}</Text>
      </Text>
    ),
    actions,
    status: `CI ${icon} ${summary(w)}`,
  }
}
