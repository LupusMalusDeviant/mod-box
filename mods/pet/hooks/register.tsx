// Desktop Pet: a small always-on-top companion on the Windows desktop (a cardboard box with a
// face, or one of a dozen animals and friends) that says in a speech bubble what Claude is doing: which file it reads or changes, which
// command runs, when a guard holds something, and a short summary when the turn is done. It works
// from the events alone, no tokens; with option summary "haiku" the end of a turn is put in one
// sentence by Haiku. The pet is its own little program (overlay/Pet.cs), compiled once with the
// C# compiler that ships with Windows and signed with the Sign Guard script, when one is set.
// The mod writes a status file the pet reads. When Claude asks a question (AskUserQuestion) or
// Next Steps has suggestions, the bubble shows them as buttons; a click lands in
// <status file>.answer, which this mod picks up: the question is answered (whichever comes first,
// the pet or the dialog in Claude Code) or the suggestion is sent. A permission request is only
// shown: approving stays with Claude Code's own dialog.
import { read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { addUsage, USAGE_STORE } from '../../settings/hooks/usage'
import type { UsageBook } from '../../settings/hooks/usage'

export type PetKind = 'hello' | 'work' | 'done' | 'ask' | 'error' | 'bye'
/** One message for the bubble; with `ask` and `choices`, buttons whose click answers `ask`. */
export type PetNote = { kind: PetKind; title: string; text: string; ask?: string; choices?: string[] }
/** Which figure stands on the desktop and, for cat, dog and bunny, its coat. */
export type PetLook = { pet: string; fur: string }

export const PETS = ['box', 'cat', 'dog', 'fox', 'bunny', 'hamster', 'owl', 'penguin', 'frog', 'axolotl', 'dragon', 'robot', 'ghost']
export const FURS = ['auto', 'ginger', 'black', 'white', 'grey', 'brown', 'cream', 'calico', 'siamese', 'tuxedo']

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
let look: PetLook = { pet: 'box', fur: 'auto' }
let petChoice = 'box'
let perSession = false
let askViaPet = true
let suggestViaPet = true
// Picks the pet may answer, by id; the answer file's last time read.
const pending = new Map<string, (choice: string) => void>()
let answerAt = 0
// Next Steps: after a turn the suggestions arrive a few seconds later; watched until then.
let watchStepsUntil = 0
let stepsShownFor = ''
let lastDone: PetNote | null = null
const NEXT_STEPS = { plugin: 'mod-box', key: 'ns_steps' } as const
const POLL_MS = 600
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
export function statusText(note: PetNote, at: number, figure?: PetLook): string {
  const esc = (s: string) => s.replace(/\r?\n/g, '\\n')
  const lines = [`at=${at}`, `kind=${note.kind}`, `title=${esc(note.title)}`, `text=${esc(note.text)}`]
  if (figure) lines.push(`pet=${figure.pet}`, `fur=${figure.fur}`)
  if (note.ask && note.choices?.length) lines.push(`ask=${note.ask}`, ...note.choices.map(c => `choice=${esc(c)}`))
  return [...lines, ''].join('\n')
}

/** What the pet wrote after a click: the id it answers and the choice. Pure, for the tests. */
export function parseAnswer(text: string): { id: string; choice: string } | null {
  const get = (k: string) => new RegExp(`^${k}=(.*)$`, 'm').exec(text)?.[1]?.trim() ?? ''
  const id = get('id')
  const choice = get('choice').replace(/\\n/g, '\n')
  return id && choice ? { id, choice } : null
}

/** The figure for a session: the one chosen, or any one for "random" (kept for the session). */
export function pickLook(pet: string, fur: string, roll = Math.random): PetLook {
  const figure = pet === 'random' ? PETS[1 + Math.floor(roll() * (PETS.length - 1))]! : PETS.includes(pet) ? pet : 'box'
  const coat = fur === 'random' ? FURS[1 + Math.floor(roll() * (FURS.length - 1))]! : FURS.includes(fur) ? fur : 'auto'
  return { pet: figure, fur: coat }
}

const waitPick = (id: string) => new Promise<string>(resolve => pending.set(id, resolve))

// Reads the pet's answer file while something waits for a click, and offers Next Steps'
// suggestions once they are there.
async function poll($: EngineInterface) {
  if (!statusPath) return
  if (pending.size > 0) {
    const at = await $.fs.stat(`${statusPath}.answer`).then(x => x.mtimeMs).catch(() => 0)
    if (at && at !== answerAt) {
      answerAt = at
      const a = parseAnswer(String(await $.fs.read(`${statusPath}.answer`).catch(() => '')))
      const done = a ? pending.get(a.id) : undefined
      if (a && done) {
        pending.delete(a.id)
        done(a.choice)
      }
    }
  }
  if (suggestViaPet && watchStepsUntil && lastDone) {
    if ((await $.clock.now()) > watchStepsUntil) {
      watchStepsUntil = 0
      return
    }
    const s = (await read($, NEXT_STEPS as any).catch(() => null)) as { turnId: string; items: string[] } | null
    if (!s || !s.items?.length || s.turnId === stepsShownFor) return
    stepsShownFor = s.turnId
    watchStepsUntil = 0
    const id = `ns-${s.turnId}`
    for (const key of [...pending.keys()]) if (key.startsWith('ns-')) pending.delete(key)
    pending.set(id, text => void sendSuggestion($, text))
    await say($, { ...lastDone, ask: id, choices: s.items })
  }
}

async function sendSuggestion($: EngineInterface, text: string) {
  await say($, { kind: 'work', title: titled(t('Los geht’s', 'On it')), text: cut(text, 120) })
  await $.prompt.submit({ text }).catch(() => $.prompt.fill({ text }).catch(() => {}))
}

async function say($: EngineInterface, note: PetNote) {
  if (!statusPath) return
  const now = await $.clock.now()
  await $.fs.write(statusPath, statusText(note, now, look)).catch(() => {})
  if (now - started > RESTART_MS) void ensure($).catch(() => {})
}

type AskQuestion = { question: string; header?: string; multiSelect?: boolean; type?: string; options?: Array<{ label: string }> }

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
  petChoice = String(options.kind ?? 'box')
  look = pickLook(petChoice, String(options.fur ?? 'auto'))
  perSession = options.perSession === 'on'
  askViaPet = options.ask !== 'off'
  suggestViaPet = options.suggest !== 'off'

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    if (!isWindows) return r
    const temp = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || ''
    // One pet for all sessions, or (option) one each: then every session has its own status file.
    const sid = perSession ? `-${String(await $.session.id().catch(() => '')).replace(/[^\w-]/g, '').slice(0, 8)}` : ''
    statusPath = temp ? `${temp}\\mod-box-pet${sid}.txt` : ''
    $.clock.every(POLL_MS, () => void poll($).catch(() => {}))
    project = base(await $.session.cwd().catch(() => ''))
    await $.command.register({ name: 'pet', description: t('Desktop-Pet: zeigen, verabschieden (stop) oder Figur wählen (z. B. /pet cat calico)', 'Desktop Pet: show it, send it off (stop) or pick a figure (e.g. /pet cat calico)'), argumentHint: '[stop | <figure> [coat]]' })
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
    watchStepsUntil = 0
    lastDone = null
    for (const key of [...pending.keys()]) if (key.startsWith('ns-')) pending.delete(key)
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
    lastDone = { kind, title, text: gist(e.answer) || t('Fertig.', 'Done.') }
    if (suggestViaPet && !isQuestion) watchStepsUntil = (await $.clock.now()) + 45_000
    void (async () => {
      await say($, { kind, title, text: gist(e.answer) || t('Fertig.', 'Done.') })
      if (summary === 'haiku' && e.answer.trim().length > 200) {
        const text = await sum($, e.answer).catch(() => null)
        if (text) {
          lastDone = { kind, title, text }
          await say($, { kind, title, text })
        }
      }
    })().catch(() => {})
    return r
  })

  // Claude's question: as buttons in the bubble too. Whichever answers first, the pet or the dialog
  // in Claude Code, counts; the other is closed (a hook returning while next is pending aborts it).
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const call = e as unknown as { questions?: AskQuestion[]; tool_use_id?: string; agentId?: string }
    if (!statusPath || !askViaPet || call.agentId) return next(e)
    const questions = call.questions ?? []
    const isPickable = questions.length > 0 && questions.every(q => !q.multiSelect && (q.type ?? 'choice') === 'choice' && (q.options?.length ?? 0) >= 2)
    const ask = (q: AskQuestion | undefined) => titled(q?.header ? `${t('Frage', 'Question')} · ${q.header}` : t('Frage an dich', 'A question for you'))
    if (!isPickable) {
      void say($, { kind: 'ask', title: ask(questions[0]), text: cut(questions[0]?.question ?? t('Claude fragt dich etwas.', 'Claude has a question.'), 200) })
      return next(e)
    }
    const beneath = next(e)
    beneath.catch(() => {})
    const answers: Record<string, string> = {}
    for (const [n, q] of questions.entries()) {
      const id = `q-${call.tool_use_id ?? 'x'}-${n}`
      await say($, { kind: 'ask', title: ask(q), text: cut(q.question, 200), ask: id, choices: q.options!.map(o => o.label) })
      const won = await Promise.race([beneath.then(r => ({ r, c: null as string | null })), waitPick(id).then(c => ({ r: null, c }))])
      if (won.c === null) {
        pending.delete(id)
        void say($, { kind: 'work', title: titled(t('Arbeite', 'Working')), text: t('Antwort erhalten, weiter geht’s.', 'Got the answer, carrying on.') })
        return won.r!
      }
      answers[q.question] = won.c
    }
    void say($, { kind: 'work', title: titled(t('Arbeite', 'Working')), text: t('Antwort erhalten, weiter geht’s.', 'Got the answer, carrying on.') })
    return { result: { questions, answers } } as any
  })

  // A permission request: shown, so it is not missed; the answer stays in Claude Code's dialog.
  on('classic.PermissionRequest', {}, async ($, e, next) => {
    const req = e as unknown as { tool_name?: string; tool_input?: Record<string, unknown> }
    if (statusPath && req.tool_name) {
      void say($, {
        kind: 'ask',
        title: titled(t('Genehmigung nötig', 'Permission needed')),
        text: `${describe(req.tool_name, req.tool_input ?? {}, lang === 'de')} · ${t('bitte in Claude Code bestätigen', 'please confirm in Claude Code')}`,
      })
    }
    return next(e)
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    if (!isWindows) return { text: t('Das Desktop-Pet gibt es nur unter Windows.', 'The desktop pet is Windows only.') }
    const [first = '', second = ''] = String(e.args ?? '').trim().toLowerCase().split(/\s+/)
    if (first === 'random' || PETS.includes(first)) {
      const fur = FURS.includes(second) || second === 'random' ? second : look.fur
      look = pickLook(first, fur)
      await $.config.set({ key: 'mod-box.petKind', value: first }).catch(() => null)
      if (second) await $.config.set({ key: 'mod-box.petFur', value: fur }).catch(() => null)
      await ensure($)
      await say($, { kind: 'hello', title: titled(t('Da bin ich', 'Here I am')), text: t('Wie gefalle ich dir?', 'How do I look?') })
      return { text: t(`Das Pet ist jetzt: ${look.pet}${look.fur !== 'auto' ? ` (${look.fur})` : ''}.`, `The pet is now: ${look.pet}${look.fur !== 'auto' ? ` (${look.fur})` : ''}.`) }
    }
    if (first && first !== 'stop') return { text: t(`Figuren: ${PETS.join(', ')}, random. Fell: ${FURS.slice(1).join(', ')}.`, `Figures: ${PETS.join(', ')}, random. Coats: ${FURS.slice(1).join(', ')}.`) }
    if (first === 'stop') {
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
