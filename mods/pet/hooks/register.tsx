// Desktop Pet: a small always-on-top companion on the Windows desktop (a cardboard box with a
// face) that says in a speech bubble what Claude is doing: which file it reads or changes, which
// command runs, when a guard holds something, and a short summary when the turn is done. It works
// from the events alone, no tokens; with option summary "haiku" the end of a turn is put in one
// sentence by Haiku. The pet is its own little program (overlay/Pet.cs), compiled once with the
// C# compiler that ships with Windows and signed with the Sign Guard script, when one is set.
// The mod only writes a status file; the pet reads it.
import { update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { addUsage, USAGE_STORE } from '../../settings/hooks/usage'
import type { UsageBook } from '../../settings/hooks/usage'

export type PetKind = 'hello' | 'work' | 'done' | 'ask' | 'error' | 'bye'
export type PetNote = { kind: PetKind; title: string; text: string }

let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
let bubbleSec = '9'
let summary = 'off'
let signScript = ''
let isWindows = false
let statusPath = ''
let project = ''
let started = 0
let steps = 0
const changed = new Set<string>()

const MODEL = 'haiku'
const USAGE = { plugin: 'mod-box', key: 'mb_usage' } as const
// The pet is started again at most this often (it exits after two quiet hours or a "bye").
const RESTART_MS = 60_000

const base = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '').split('/').pop() || p
const cut = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > n ? `${one.slice(0, n - 1)}…` : one
}

/** One line on a tool call, in the person's words. Pure, for the tests. */
export function describe(tool: string, input: Record<string, unknown>, de: boolean): string {
  const tr = (a: string, b: string) => (de ? a : b)
  const s = (k: string) => String(input[k] ?? '')
  switch (tool) {
    case 'Read':
      return tr(`Lese ${base(s('file_path'))}`, `Reading ${base(s('file_path'))}`)
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return tr(`Ändere ${base(s('file_path') || s('notebook_path'))}`, `Changing ${base(s('file_path') || s('notebook_path'))}`)
    case 'Write':
      return tr(`Schreibe ${base(s('file_path'))}`, `Writing ${base(s('file_path'))}`)
    case 'Bash':
    case 'PowerShell':
      return s('description') ? cut(s('description'), 90) : tr(`Führe aus: ${cut(s('command'), 70)}`, `Running: ${cut(s('command'), 70)}`)
    case 'Grep':
      return tr(`Suche nach „${cut(s('pattern'), 40)}“`, `Searching for "${cut(s('pattern'), 40)}"`)
    case 'Glob':
      return tr(`Suche Dateien: ${cut(s('pattern'), 50)}`, `Looking for files: ${cut(s('pattern'), 50)}`)
    case 'WebFetch': {
      const host = /^https?:\/\/([^/]+)/.exec(s('url'))?.[1] ?? s('url')
      return tr(`Lese Webseite ${cut(host, 50)}`, `Reading ${cut(host, 50)}`)
    }
    case 'WebSearch':
      return tr(`Suche im Web: ${cut(s('query'), 60)}`, `Searching the web: ${cut(s('query'), 60)}`)
    case 'Agent':
    case 'Task':
      return tr(`Schicke einen Helfer los: ${cut(s('description'), 60)}`, `Sending a helper: ${cut(s('description'), 60)}`)
    case 'TodoWrite':
      return tr('Plane die nächsten Schritte', 'Planning the next steps')
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(tool)
      if (mcp) return tr(`Nutze ${mcp[1]}: ${mcp[2]!.replace(/_/g, ' ')}`, `Using ${mcp[1]}: ${mcp[2]!.replace(/_/g, ' ')}`)
      return tr(`Benutze ${tool}`, `Using ${tool}`)
    }
  }
}

/** The first sentence or two of an answer, without markdown. Pure, for the tests. */
export function gist(answer: string, max = 170): string {
  const plain = answer
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, '$1')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = plain.match(/[^.!?]+[.!?]+/g) ?? [plain]
  let out = ''
  for (const sentence of sentences) {
    if (out && (out + sentence).length > max) break
    out += sentence
  }
  return cut(out || plain, max)
}

/** The status file the pet reads: key=value lines, newlines in the text escaped. */
export function statusText(note: PetNote, at: number): string {
  const esc = (s: string) => s.replace(/\r?\n/g, '\\n')
  return [`at=${at}`, `kind=${note.kind}`, `title=${esc(note.title)}`, `text=${esc(note.text)}`, ''].join('\n')
}

async function say($: EngineInterface, note: PetNote) {
  if (!statusPath) return
  const now = await $.clock.now()
  await $.fs.write(statusPath, statusText(note, now)).catch(() => {})
  if (now - started > RESTART_MS) void ensure($).catch(() => {})
}

const titled = (what: string) => (project ? `${project} · ${what}` : what)

// Builds the pet when it is missing or older than its source, and starts it (a second start
// exits at once: the pet holds a named mutex).
const BUILD =
  "Get-Process ModBoxPet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; " +
  'New-Item -ItemType Directory -Force $env:PET_DIR | Out-Null; ' +
  '$csc = Join-Path $env:WINDIR "Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe"; ' +
  'if (-not (Test-Path $csc)) { $csc = Join-Path $env:WINDIR "Microsoft.NET\\Framework\\v4.0.30319\\csc.exe" }; ' +
  '& $csc -nologo -target:winexe -optimize+ "-out:$env:PET_EXE" -r:System.Windows.Forms.dll -r:System.Drawing.dll $env:PET_SRC; exit $LASTEXITCODE'
const START = "Start-Process -FilePath $env:PET_EXE -ArgumentList ('\"' + $env:PET_STATUS + '\"'), $env:PET_SECS"

async function ensure($: EngineInterface): Promise<string | null> {
  if (!isWindows || !statusPath) return null
  started = await $.clock.now()
  const home = (await $.env.get('LOCALAPPDATA')) || ''
  if (!home) return t('LOCALAPPDATA fehlt', 'LOCALAPPDATA is missing')
  const dir = `${home}\\mod-box\\pet`
  const exe = `${dir}\\ModBoxPet.exe`
  const src = `${$.plugin.root}/mods/pet/overlay/Pet.cs`.replace(/\//g, '\\')
  const exeAt = await $.fs.stat(exe).then(s => s.mtimeMs).catch(() => 0)
  const srcAt = await $.fs.stat(src).then(s => s.mtimeMs).catch(() => 0)
  const env = { PET_DIR: dir, PET_EXE: exe, PET_SRC: src, PET_STATUS: statusPath, PET_SECS: bubbleSec }
  if (!exeAt || exeAt < srcAt) {
    const built = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', BUILD], { env, timeoutMs: 60_000 })
    if (built.exitCode !== 0) return cut(built.stdout || built.stderr || 'csc failed', 200)
    if (signScript) {
      await $.process
        .run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', signScript, '-Exe', exe], { timeoutMs: 120_000 })
        .catch(() => null)
    }
  }
  const run = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', START], { env, timeoutMs: 15_000 })
  return run.exitCode === 0 ? null : cut(run.stderr || 'start failed', 200)
}

async function sum($: EngineInterface, answer: string): Promise<string | null> {
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 80,
    timeoutMs: 15_000,
    system:
      'You are a friendly desktop pet watching a coding assistant. Say in ONE short sentence (max 20 words) what the assistant ' +
      `just did or found, for the person at the desk. ${lang === 'de' ? 'Answer in German, informal (du).' : 'Answer in English.'} ` +
      'No markdown, no quotes, no greeting.',
    prompt: `<reply>\n${answer.slice(0, 3000)}\n</reply>`,
  })
  if (r.usage) {
    await update($, USAGE, b => addUsage(b, 'pet', MODEL, r.usage!)).catch(() => {})
    const total = await $.store.get(USAGE_STORE).catch(() => null)
    await $.store.set(USAGE_STORE, addUsage(total as UsageBook | null, 'pet', MODEL, r.usage)).catch(() => {})
  }
  return r.isAnswered && r.text.trim() ? cut(r.text, 200) : null
}

export const register: Register = (on, options) => {
  lang = options.language === 'de' ? 'de' : 'en'
  bubbleSec = String(options.bubble ?? '9')
  summary = String(options.summary ?? 'off')
  signScript = String(options.signScript ?? '').trim()

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    if (!isWindows) return r
    const temp = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || ''
    statusPath = temp ? `${temp}\\mod-box-pet.txt` : ''
    project = base(await $.session.cwd().catch(() => ''))
    await $.command.register({ name: 'pet', description: t('Desktop-Pet: zeigen (ohne Argument) oder verabschieden (stop)', 'Desktop Pet: show it (no argument) or send it off (stop)'), argumentHint: '[stop]' })
    void (async () => {
      await say($, { kind: 'hello', title: titled(t('Hallo!', 'Hello!')), text: t('Ich schaue Claude über die Schulter.', "I'm watching over Claude's shoulder.") })
      await ensure($)
    })().catch(() => {})
    return r
  })

  on('turn.start', {}, async ($, e, next) => {
    const r = await next(e)
    steps = 0
    changed.clear()
    if (e.text.trim()) void say($, { kind: 'work', title: titled(t('Los geht’s', 'On it')), text: cut(e.text, 120) })
    return r
  })

  on('tool.call', {}, async ($, e, next) => {
    if (!statusPath || (e as any).agentId) return next(e)
    const tool = String(e.tool)
    const input = e as unknown as Record<string, unknown>
    void say($, { kind: 'work', title: titled(t('Arbeite', 'Working')), text: describe(tool, input, lang === 'de') })
    const r = await next(e)
    steps++
    if (r.deny) {
      void say($, { kind: 'ask', title: titled(t('Angehalten', 'Held')), text: cut(String(r.deny), 160) })
    } else if ((r as any).isError) {
      void say($, { kind: 'error', title: titled(t('Hoppla', 'Oops')), text: t(`${tool} ist fehlgeschlagen.`, `${tool} failed.`) })
    } else if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(tool)) {
      changed.add(String(input.file_path ?? input.notebook_path ?? ''))
    }
    return r
  })

  on('turn.complete', {}, async ($, e, next) => {
    const r = await next(e)
    if (!statusPath || e.agentId) return r
    if (e.reason === 'aborted' || e.isAborted) {
      void say($, { kind: 'ask', title: titled(t('Abgebrochen', 'Stopped')), text: t('Du hast unterbrochen. Ich warte.', 'You stopped it. Waiting for you.') })
      return r
    }
    if (e.reason !== 'answer') {
      void say($, { kind: 'error', title: titled(t('Fehler', 'Error')), text: t('Der Turn endete mit einem Fehler.', 'The turn ended with an error.') })
      return r
    }
    const facts = [
      steps ? t(`${steps} Schritt${steps === 1 ? '' : 'e'}`, `${steps} step${steps === 1 ? '' : 's'}`) : '',
      changed.size ? t(`${changed.size} Datei${changed.size === 1 ? '' : 'en'} geändert`, `${changed.size} file${changed.size === 1 ? '' : 's'} changed`) : '',
    ].filter(Boolean)
    const isQuestion = /\?\s*$/.test(e.answer.trim())
    const kind: PetKind = isQuestion ? 'ask' : 'done'
    const title = titled([isQuestion ? t('Frage an dich', 'A question for you') : t('Fertig', 'Done'), ...facts].join(' · '))
    void (async () => {
      await say($, { kind, title, text: gist(e.answer) || t('Fertig.', 'Done.') })
      if (summary === 'haiku' && e.answer.trim().length > 200) {
        const text = await sum($, e.answer).catch(() => null)
        if (text) await say($, { kind, title, text })
      }
    })().catch(() => {})
    return r
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    if (!isWindows) return { text: t('Das Desktop-Pet gibt es nur unter Windows.', 'The desktop pet is Windows only.') }
    if (String(e.args ?? '').trim() === 'stop') {
      await say($, { kind: 'bye', title: titled(t('Tschüss!', 'Bye!')), text: t('Bis später.', 'See you later.') })
      return { text: t('Das Pet verabschiedet sich.', 'The pet says goodbye.') }
    }
    const problem = await ensure($)
    await say($, { kind: 'hello', title: titled(t('Da bin ich', 'Here I am')), text: t('Ich schaue Claude über die Schulter.', "I'm watching over Claude's shoulder.") })
    return { text: problem ? t(`Das Pet ließ sich nicht starten: ${problem}`, `The pet did not start: ${problem}`) : t('Das Pet ist da (rechte untere Ecke, verschiebbar).', 'The pet is there (bottom right, drag it anywhere).') }
  })

  on('session.end', {}, async ($, e, next) => {
    if (statusPath && e.reason !== 'clear') await say($, { kind: 'bye', title: titled(t('Tschüss!', 'Bye!')), text: t('Bis zum nächsten Mal.', 'See you next time.') })
    return next(e)
  })
}
