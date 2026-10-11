// Sign guard: sign the new binaries after a Windows build.
// Detects build commands in the Bash tool (cargo --release, dotnet publish, go build, pyinstaller,
// tauri build, electron-builder, msbuild, npm/pnpm/yarn run dist|build:win|package) and then looks
// under the working folder for every .exe/.msi/.msix created during the build.
// Mode "fragen" (ask): band with a button. Mode "auto": sign right away.
// Signing uses your own script (option script, called with -Exe <file>). Already signed
// files are skipped: with option subject only those signed by that certificate, otherwise any validly signed one.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SignFile, SignJob } from '../types'
import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'

const job = atom({ plugin: 'mod-box', key: 'sg_job' } as const, null as SignJob | null)
const busy = atom({ plugin: 'mod-box', key: 'sg_busy' } as const, false)

const BINARY = /\.(exe|msi|msix)$/i
// Folders holding intermediate output or third-party files.
const SKIP = new Set(['node_modules', '.git', 'deps', 'incremental', '.fingerprint', 'build', 'obj', 'examples', '.venv', 'venv', '__pycache__', 'vendor', '.cargo'])
const MAX_DEPTH = 7
const MAX_ENTRIES = 8000
// For band(): the script path from the options.
let scriptOption = ''
// Certificate whose signature counts as "already done" (empty: any valid signature).
let subject = ''

// Display language (options.language: de | en)
let lang: 'de' | 'en' = 'de'
const t = (de: string, en: string) => (lang === 'en' ? en : de)

export const BUILD =
  /\b(cargo\s+(?:build|tauri\s+build)[^;&|]*--release|dotnet\s+publish|go\s+build|pyinstaller|tauri\s+build|electron-builder|msbuild|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dist|make|package|build:win|tauri\s+build)\b)/i

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

  const auto = options.mode === 'auto'
  const scriptOpt = String(options.script ?? '').trim()
  scriptOption = scriptOpt
  subject = String(options.subject ?? '').trim()
  lang = options.language === 'en' ? 'en' : 'de'

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cmd = String(e.command ?? '')
    const m = BUILD.exec(cmd)
    if (!m) return next(e)
    const startedAt = (await $.clock.now()) - 2000
    const result = await next(e)
    if (('deny' in result && result.deny !== undefined) || result.isError) return result
    if ((await $.env.get('OS')) !== 'Windows_NT') return result
    void found($, m[1] ?? m[0], startedAt).then(async j => {
      if (j && auto) await signAll($, scriptOpt)
    }).catch(() => {})
    return result
  })

}

async function found($: EngineInterface, build: string, since: number): Promise<SignJob | null> {
  const cwd = await $.session.cwd()
  const files: string[] = []
  let seen = 0
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > MAX_DEPTH || seen > MAX_ENTRIES) return
    const entries = await $.fs.list(dir).catch(() => [])
    for (const x of entries) {
      seen++
      const p = `${dir}/${x.name}`
      if (x.kind === 'dir') {
        if (!SKIP.has(x.name) && !x.name.startsWith('.')) await walk(p, depth + 1)
      } else if (x.kind === 'file' && BINARY.test(x.name) && x.mtimeMs >= since) {
        files.push(p)
      }
    }
  }
  await walk(cwd, 0)
  if (files.length === 0) return null
  const signed = await Promise.all(files.map(f => isOurs($, f)))
  const todo = files.filter((_, i) => !signed[i])
  if (todo.length === 0) return null
  const j: SignJob = {
    build: build.trim().slice(0, 40),
    cwd,
    at: await $.clock.now(),
    files: todo.map(path => ({ path, ok: null, message: '' })),
    phase: 'gefunden',
    isDismissed: false,
  }
  await update($, job, () => j)
  return j
}

async function scriptPath($: EngineInterface, opt: string): Promise<string> {
  if (opt) return opt
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  return `${home}\\.claude\\skills\\sign-binary\\sign.ps1`
}

async function isOurs($: EngineInterface, file: string): Promise<boolean> {
  const r = await $.process
    .run(['powershell', '-NoProfile', '-NonInteractive', '-Command', `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; "$($s.Status)|$($s.SignerCertificate.Subject)"`], { timeoutMs: 20_000 })
    .catch(() => null)
  if (!r || r.exitCode !== 0) return false
  const [status = '', who = ''] = r.stdout.trim().split('|')
  return subject ? who.includes(subject) : status === 'Valid'
}

async function signAll($: EngineInterface, opt: string) {
  const j = await read($, job)
  if (!j || (await read($, busy))) return
  const script = await scriptPath($, opt)
  if (!(await $.fs.exists(script))) {
    await update($, job, (x): SignJob | null => (x ? { ...x, phase: 'fehler', files: x.files.map(f => ({ ...f, ok: false, message: t(`Skript fehlt: ${script}`, `script missing: ${script}`) })) } : x))
    $.ui.toast(t(`Signier-Wächter: ${script} nicht gefunden`, `Sign Guard: ${script} not found`))
    return
  }
  await update($, busy, () => true)
  const results: SignFile[] = []
  try {
    for (const f of j.files) {
      const r = await $.process
        .run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Exe', f.path], { cwd: j.cwd, timeoutMs: 120_000 })
        .catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
      const text = (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim().split('\n').filter(Boolean).pop() ?? ''
      results.push({ path: f.path, ok: r.exitCode === 0, message: text.slice(0, 300) })
    }
  } finally {
    await update($, busy, () => false)
  }
  const good = results.filter(r => r.ok).length
  await update($, job, (x): SignJob | null => (x ? { ...x, files: results, phase: good === results.length ? 'signiert' : good > 0 ? 'teilweise' : 'fehler' } : x))
  $.ui.toast(t(`Signier-Wächter: ${good} von ${results.length} signiert`, `Sign Guard: ${good} of ${results.length} signed`))
}

function base(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

// For the Mod Box band manager (instead of an AbovePrompt hook of its own).
export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  const j = await read($, job)
  if (!j || j.isDismissed) return null
  const isBusy = await read($, busy)
  const { Text, Button } = $.ui.resolve(e)
  const names = j.files.map(f => `${f.ok === true ? '✔' : f.ok === false ? '✘' : '·'} ${base(f.path)}`).join('  ')
  const head =
    isBusy ? t('signiere …', 'signing …')
    : j.phase === 'gefunden' ? t(`${j.files.length} neue Binärdatei(en) nach ${j.build}:`, `${j.files.length} new binary file(s) after ${j.build}:`)
    : j.phase === 'signiert' ? t('signiert:', 'signed:')
    : j.phase === 'teilweise' ? t('teilweise signiert:', 'partly signed:')
    : t('Signieren fehlgeschlagen:', 'Signing failed:')
  const color = j.phase === 'signiert' ? 'green' : j.phase === 'gefunden' ? 'cyan' : 'yellow'
  const actions: unknown[] = []
  if (j.phase === 'gefunden' && !isBusy) actions.push(<Button key="sg-sign" label={t('Signieren', 'Sign')} plain onPress={() => void signAll($, scriptOption)} />)
  if (j.phase !== 'gefunden' && !isBusy) {
    actions.push(<Button key="sg-why" label="Details" plain onPress={() => $.ui.log(j.files.map(f => `${f.path}: ${f.message || (f.ok ? t('signiert', 'signed') : t('offen', 'open'))}`).join('\n'))} />)
  }
  actions.push(<Button key="sg-weg" label="×" plain onPress={() => void update($, job, x => (x ? { ...x, isDismissed: true } : x))} />)
  return {
    id: 'signGuard',
    urgent: j.phase !== 'signiert',
    short: (
      <Text>
        <Text color={color} bold>{'🔏'}</Text>
        <Text dimColor>{` ${j.files.filter(f => f.ok).length}/${j.files.length}`}</Text>
      </Text>
    ),
    line: (
      <Text>
        <Text color={color} bold>{'🔏 '}</Text>
        <Text>{`${head} `}</Text>
        <Text dimColor>{names}</Text>
      </Text>
    ),
    actions,
    status: `🔏 ${head} ${names}`,
  }
}
