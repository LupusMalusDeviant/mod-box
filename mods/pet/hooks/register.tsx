// Desktop Pet: a small always-on-top companion on the Windows desktop (a cardboard box with a
// face, or one of a dozen animals and friends) that says in a speech bubble what Claude is doing: which file it reads or changes, which
// command runs, when a guard holds something, and a short summary when the turn is done. It works
// from the events alone, no tokens; with option summary "haiku" the end of a turn is put in one
// sentence by Haiku. The pet is its own little program (overlay/Pet.cs), compiled once with the
// C# compiler that ships with Windows and signed with the Sign Guard script (or, as there, the
// sign-binary skill's when none is set and it exists).
// The mod writes a status file the pet reads. When Claude asks a question (AskUserQuestion) or
// Next Steps has suggestions, the bubble shows them as buttons; a click lands in
// <status file>.answer, which this mod picks up: the question is answered (whichever comes first,
// the pet or the dialog in Claude Code) or the suggestion is sent. A permission request is shown;
// with option permissions "answer" the bubble also offers "allow once" and "deny" for a while.
// The pet's right-click menu picks its figure (answer id "look"), as /pet <figure> [coat] does:
// with one pet per session for that session alone, otherwise as the setting for every session.
// The pet watches the prompt cache too: a few minutes before it goes cold it warns (with a button
// that keeps it warm, when the Cache Meter is on). With one pet per session a session's pet stays
// only while its cache is warm: it goes to sleep when the cache is cold and is back with the next
// message.
// With option typing on, a hotkey, the pet's menu or a button in the bubble opens a small input box
// over the desktop: the text goes to this session as the next prompt, or as the answer to Claude's
// open question (free text, "Other"), or in place of a suggestion. Any program of the same user can
// write the answer file, so this is off by default.
import { read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { addUsage, USAGE_STORE } from '../../settings/hooks/usage'
import type { UsageBook } from '../../settings/hooks/usage'

export type PetKind = 'hello' | 'work' | 'done' | 'ask' | 'error' | 'bye' | 'cold'
/** One message for the bubble; with `ask` and `choices`, buttons whose click answers `ask`. */
export type PetNote = { kind: PetKind; title: string; text: string; ask?: string; choices?: string[]; free?: string }
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
let permissions: 'show' | 'answer' = 'show'
let canType = false
let remindSec = 60
let hotkey = ''
// Picks the pet may answer, by id; the answer file's last time read.
const pending = new Map<string, (choice: string) => void>()
let answerAt = 0
// Next Steps: after a turn the suggestions arrive a few seconds later; watched until then.
let watchStepsUntil = 0
let stepsShownFor = ''
let lastDone: PetNote | null = null
// The last answer, compact, for a click on the pet: with its buttons while they still apply.
let recap: PetNote | null = null
const NEXT_STEPS = { plugin: 'mod-box', key: 'ns_steps' } as const
const POLL_MS = 600
// The prompt cache: how long it stays warm (the Cache Meter's setting), when the pet warns.
let cacheTtlMs = 60 * 60_000
let warnMs = 5 * 60_000
let lastRequestAt = 0
let isTurnRunning = false
let warnedFor = 0
let coldFor = 0
let isAsleep = false
let cacheCheckedAt = 0
const CACHE_CHECK_MS = 5_000
const KEEP_WARM_ARGS = '1h'
// Tools whose permission request is the person's own decision (a plan to approve): never answered by the pet.
const PERSONAL_TOOLS = ['ExitPlanMode', 'EnterPlanMode']
// How long a permission request waits for a click in the pet (option permissions "answer").
const PERMIT_WAIT_S = 90
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

/** An answer in short for a click on the pet: its gist, and the question it ends with. Pure. */
export function compact(answer: string, question: string | null, max = 320): string {
  const head = gist(answer, question ? 200 : max)
  return question && !head.includes(question) ? `${head}\n${question}` : head
}

/** The question an answer ends with (in its last paragraph), without markdown; null when none. Pure. */
export function lastQuestion(answer: string, max = 200): string | null {
  const paragraphs = answer.replace(/```[\s\S]*?```/g, ' ').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
  const last = paragraphs.at(-1) ?? ''
  if (!last.includes('?')) return null
  const sentences = gist(last, 100_000).match(/[^.!?]+[.!?]+|[^.!?]+$/g) ?? []
  const question = [...sentences].reverse().find(s => s.trim().endsWith('?'))
  return question ? cut(question.trim(), max) : null
}

/** The status file the pet reads: key=value lines, newlines in the text escaped. */
export function statusText(note: PetNote, at: number, figure?: PetLook, extra: Record<string, string> = {}): string {
  const esc = (s: string) => s.replace(/\r?\n/g, '\\n')
  const lines = [`at=${at}`, `kind=${note.kind}`, `title=${esc(note.title)}`, `text=${esc(note.text)}`]
  if (figure) lines.push(`pet=${figure.pet}`, `fur=${figure.fur}`)
  if (note.ask && note.choices?.length) lines.push(`ask=${note.ask}`, ...note.choices.map(c => `choice=${esc(c)}`))
  if (note.free) lines.push(`free=${note.free}`)
  for (const [k, v] of Object.entries(extra)) if (v) lines.push(`${k}=${esc(v)}`)
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

// One pet per session: each session's own figure, kept in $.store (the latest LOOKS_KEPT sessions).
const LOOKS_STORE = 'pet:looks'
const LOOKS_KEPT = 40
let sessionId = ''
// ...and when each one last sent a request, so a session that only starts again (the plugin
// reloaded, the app reopened) knows whether its cache is still warm.
const ACTIVE_STORE = 'pet:active'

async function markRequest($: EngineInterface) {
  lastRequestAt = (await $.clock.now()) || 1
  if (!perSession || !sessionId) return
  const all = ((await $.store.get(ACTIVE_STORE).catch(() => null)) ?? {}) as Record<string, number>
  delete all[sessionId]
  const kept = Object.entries(all).slice(-(LOOKS_KEPT - 1))
  await $.store.set(ACTIVE_STORE, Object.fromEntries([...kept, [sessionId, lastRequestAt]])).catch(() => {})
}

// One pet per active session, at the start: a session whose cache is cold (or an old one taken up
// again, its time unknown) has no pet until its next message; a pet still running for it leaves.
async function startsAsleep($: EngineInterface, now: number): Promise<boolean> {
  if (!perSession || !sessionId) return false
  const known = (((await $.store.get(ACTIVE_STORE).catch(() => null)) ?? {}) as Record<string, number>)[sessionId]
  if (typeof known === 'number') {
    lastRequestAt = known
    return cacheState(known, now, cacheTtlMs, 0) === 'cold'
  }
  const isOld = (await $.session.messages().catch(() => [])).length > 0
  if (isOld) lastRequestAt = 0
  return isOld
}

/** "cat calico", "random", "fox": the figure and coat a menu click or /pet names. Pure, for the tests. */
export function parseLook(text: string, current: PetLook): PetLook | null {
  const [first = '', second = ''] = text.trim().toLowerCase().split(/\s+/)
  if (first !== 'random' && !PETS.includes(first)) return null
  return pickLook(first, FURS.includes(second) || second === 'random' ? second : current.fur)
}

// The figure changes: for this session alone (one pet per session) or as the setting for all.
async function applyLook($: EngineInterface, next: PetLook, named: string, hasCoat: boolean) {
  look = next
  if (perSession && sessionId) {
    const all = ((await $.store.get(LOOKS_STORE).catch(() => null)) ?? {}) as Record<string, PetLook>
    delete all[sessionId]
    const kept = Object.entries(all).slice(-(LOOKS_KEPT - 1))
    await $.store.set(LOOKS_STORE, Object.fromEntries([...kept, [sessionId, next]])).catch(() => {})
  } else {
    await $.config.set({ key: 'mod-box.petKind', value: named }).catch(() => null)
    if (hasCoat) await $.config.set({ key: 'mod-box.petFur', value: next.fur }).catch(() => null)
  }
  await say($, { kind: 'hello', title: titled(t('Da bin ich', 'Here I am')), text: t('Wie gefalle ich dir?', 'How do I look?') })
}

// The menu's pick waits for a click at any time.
// A click on the pet asks for the last answer again (id "recap").
function listenForRecap($: EngineInterface) {
  pending.set('recap', () => {
    listenForRecap($)
    void say($, recap ?? { kind: 'hello', title: titled(t('Zuletzt', 'Last')), text: t('In dieser Sitzung gab es noch keine Antwort.', 'No answer in this session yet.') }).catch(() => {})
  })
}

function listenForLook($: EngineInterface) {
  pending.set('look', choice => {
    listenForLook($)
    const next = parseLook(choice, look)
    const [named = '', coat = ''] = choice.trim().toLowerCase().split(/\s+/)
    if (next) void applyLook($, next, named, coat !== '').catch(() => {})
  })
}

const promptId = () => `prompt-${sessionId.replace(/[^\w-]/g, '').slice(0, 8) || 'x'}`

// Typed in the pet with nothing open: the session's next prompt (queued when a turn runs).
function listenForPrompt($: EngineInterface) {
  if (!canType) return
  pending.set(promptId(), text => {
    listenForPrompt($)
    void sendSuggestion($, text).catch(() => {})
  })
}

const waitPick = (id: string) => new Promise<string>(resolve => pending.set(id, resolve))

// Reads the pet's answer file while something waits for a click, and offers Next Steps'
// suggestions once they are there.
/** Where the cache stands: minutes left while warm, or cold; null before the first request. Pure. */
export function cacheState(lastAt: number, now: number, ttlMs: number, warnBeforeMs: number): 'warm' | 'cooling' | 'cold' | null {
  if (!lastAt) return null
  const left = lastAt + ttlMs - now
  return left <= 0 ? 'cold' : warnBeforeMs > 0 && left <= warnBeforeMs ? 'cooling' : 'warm'
}

// Keep-warm (the Cache Meter's /keepwarm) holds the cache: no warning, no sleep meanwhile.
async function isKeptWarm($: EngineInterface, now: number): Promise<boolean> {
  if ((await $.store.get('always').catch(() => null)) === true) return true
  const deadline = await $.store.get(`deadline:${sessionId}`).catch(() => null)
  return typeof deadline === 'number' && deadline > now
}

async function checkCache($: EngineInterface) {
  if (isTurnRunning || !lastRequestAt) return
  const now = await $.clock.now()
  if (now - cacheCheckedAt < CACHE_CHECK_MS) return
  cacheCheckedAt = now
  const state = cacheState(lastRequestAt, now, cacheTtlMs, warnMs)
  if (state === 'warm' || state === null) return
  if (await isKeptWarm($, now)) return
  if (state === 'cooling' && warnedFor !== lastRequestAt) {
    warnedFor = lastRequestAt
    const minutes = Math.max(1, Math.ceil((lastRequestAt + cacheTtlMs - now) / 60_000))
    const keep = t('Warm halten (1 Std.)', 'Keep warm (1 h)')
    const canKeep = (await $.command.list().catch(() => [] as Array<{ name: string }>)).some(c => c.name === 'keepwarm')
    const id = `warm-${lastRequestAt}`
    if (canKeep) {
      pending.set(id, choice => {
        if (choice !== keep) return void say($, { kind: 'cold', title: titled(t('Cache', 'Cache')), text: t('Gut, ich lasse ihn abkühlen.', 'Fine, I let it cool down.') })
        void $.command.run({ command: 'keepwarm', args: KEEP_WARM_ARGS }).catch(() => $.ui.toast(t(`Bitte /keepwarm ${KEEP_WARM_ARGS} eingeben.`, `Please type /keepwarm ${KEEP_WARM_ARGS}.`)))
        void say($, { kind: 'work', title: titled(t('Cache', 'Cache')), text: t('Ich halte ihn eine Stunde warm.', 'Keeping it warm for an hour.') })
      })
    }
    await say($, {
      kind: 'ask',
      title: titled(t('Cache kühlt ab', 'Cache is cooling')),
      text: t(`Noch ${minutes} Min. warm. Danach liest die nächste Nachricht den ganzen Kontext neu.`, `Warm for ${minutes} more min. After that the next message re-reads the whole context.`),
      ...(canKeep ? { ask: id, choices: [keep, t('Abkühlen lassen', 'Let it cool')] } : {}),
    })
    return
  }
  if (state === 'cold' && coldFor !== lastRequestAt) {
    coldFor = lastRequestAt
    pending.delete(`warm-${lastRequestAt}`)
    if (perSession) {
      // One pet per active session: this one goes to sleep until the next message.
      isAsleep = true
      await say($, { kind: 'bye', title: titled(t('Cache ist kalt', 'Cache is cold')), text: t('Ich lege mich schlafen. Mit der nächsten Nachricht bin ich wieder da.', "I'm going to sleep. I'll be back with your next message.") })
    } else {
      await say($, { kind: 'cold', title: titled(t('Cache ist kalt', 'Cache is cold')), text: t('Die nächste Nachricht liest den ganzen Kontext neu.', 'The next message re-reads the whole context.') })
    }
  }
}

async function poll($: EngineInterface) {
  if (!statusPath) return
  await checkCache($).catch(() => {})
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
    recap = { ...(recap ?? lastDone), ask: id, choices: s.items, free: id }
    await say($, { ...lastDone, ask: id, choices: s.items, free: id })
  }
}

async function sendSuggestion($: EngineInterface, text: string) {
  await say($, { kind: 'work', title: titled(t('Los geht’s', 'On it')), text: cut(text, 120) })
  await $.prompt.submit({ text }).catch(() => $.prompt.fill({ text }).catch(() => {}))
}

async function say($: EngineInterface, note: PetNote) {
  if (!statusPath) return
  const now = await $.clock.now()
  // Typing: a note that answers something names its id; everything else goes to this session's prompt.
  const typed = canType ? { ...note, free: note.free ?? promptId() } : { ...note, free: undefined }
  // name: the project, shown under the pet all the time
  const extra = { name: project, remind: note.kind === 'ask' && remindSec ? String(remindSec) : '', ...(canType ? { type: 'on', hotkey, typelabel: note.free ? t('Eigene Antwort …', 'Write your own answer …') : '' } : {}) }
  await $.fs.write(statusPath, statusText(typed, now, look, extra)).catch(() => {})
  // asleep (one pet per active session, cache cold): the note only reaches a pet that still runs
  if (now - started > RESTART_MS && !isAsleep) void ensure($).catch(() => {})
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
// Waits for the pet's click on one permission request: prints the answer file once it names the
// request, gives up when the status no longer offers it (answered elsewhere) or the time is over.
const WAIT =
  '$end = (Get-Date).AddSeconds([int]$env:PET_WAIT); ' +
  'while ((Get-Date) -lt $end) { ' +
  "if (Test-Path $env:PET_ANSWER) { $a = Get-Content -Raw $env:PET_ANSWER -ErrorAction SilentlyContinue; if ($a -match ('(?m)^id=' + [regex]::Escape($env:PET_ID) + '\\r?$')) { $a; exit 0 } }; " +
  "$s = Get-Content -Raw $env:PET_STATUS -ErrorAction SilentlyContinue; if ($s -notmatch ('(?m)^ask=' + [regex]::Escape($env:PET_ID) + '\\r?$')) { exit 1 }; " +
  'Start-Sleep -Milliseconds 250 }; exit 2'
const START = "Start-Process -FilePath $env:PET_EXE -ArgumentList ('\"' + $env:PET_STATUS + '\"'), $env:PET_SECS"

// The script that signs the pet: Sign Guard's, or as there the sign-binary skill's when none is
// set; nothing when that is not there either.
async function signer($: EngineInterface): Promise<string> {
  if (signScript) return signScript
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || ''
  const skill = `${home}\\.claude\\skills\\sign-binary\\sign.ps1`
  return home && (await $.fs.exists(skill).catch(() => false)) ? skill : ''
}

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
    const script = await signer($)
    if (script) {
      await $.process
        .run(['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Exe', exe], { timeoutMs: 120_000 })
        .catch(() => null)
    }
  }
  const run = await $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', START], { env, timeoutMs: 15_000 })
  return run.exitCode === 0 ? null : cut(run.stderr || 'start failed', 200)
}

// One short Haiku call, its tokens booked for the pet.
async function haiku($: EngineInterface, system: string, prompt: string, maxTokens: number): Promise<string | null> {
  const r = await $.model.complete({ model: MODEL, maxTokens, timeoutMs: 15_000, system, prompt })
  if (r.usage) {
    await update($, USAGE, b => addUsage(b, 'pet', MODEL, r.usage!)).catch(() => {})
    const total = await $.store.get(USAGE_STORE).catch(() => null)
    await $.store.set(USAGE_STORE, addUsage(total as UsageBook | null, 'pet', MODEL, r.usage)).catch(() => {})
  }
  return r.isAnswered && r.text.trim() ? r.text : null
}

async function sum($: EngineInterface, answer: string): Promise<string | null> {
  const text = await haiku(
    $,
    'You are a friendly desktop pet watching a coding assistant. In at most THREE short sentences (max 45 words) say what ' +
      'the assistant just did or found and what is still open, for the person at the desk, so they can answer without ' +
      `reading the whole reply. ${lang === 'de' ? 'Answer in German, informal (du).' : 'Answer in English.'} ` +
      'No markdown, no quotes, no greeting, no question at the end.',
    `<reply>\n${answer.slice(0, 4000)}\n</reply>`,
    140,
  )
  return text ? cut(text.replace(/\s*\n+\s*/g, ' '), 320) : null
}

/** Haiku's reply options, one per line: without bullets, numbers or quotes, at most three. Pure. */
export function parseReplies(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map(l => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/^["'„“]+|["'“”]+$/g, '').trim())
    .filter(l => l.length > 0 && l.length <= 80)
  return [...new Set(lines)].slice(0, 3)
}

// An answer that ends with a question: two or three short replies the person might give, as buttons.
async function replies($: EngineInterface, answer: string, question: string): Promise<string[]> {
  const text = await haiku(
    $,
    'A coding assistant ended its reply with a question to the person at the desk. Write the 2 or 3 most likely short ' +
      'answers that person would send back, one per line, each at most 8 words, the most likely first, different from ' +
      `each other. ${lang === 'de' ? 'In German, informal (du).' : 'In English.'} Only the answers: no numbering, no quotes.`,
    `<reply>\n${answer.slice(-2500)}\n</reply>\n<question>${question}</question>`,
    80,
  )
  return text ? parseReplies(text) : []
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
  permissions = options.permissions === 'answer' ? 'answer' : 'show'
  cacheTtlMs = (Number(options.cacheTtl) || 60) * 60_000
  canType = options.typing === 'on'
  remindSec = options.remind === 'off' ? 0 : Number(options.remind) || 60
  hotkey = String(options.hotkey ?? 'ctrl+alt+space') === 'off' ? '' : String(options.hotkey ?? 'ctrl+alt+space')
  warnMs = options.cacheWarn === 'off' ? 0 : (Number(options.cacheWarn) || 5) * 60_000

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    isWindows = (await $.env.get('OS')) === 'Windows_NT'
    if (!isWindows) return r
    const temp = (await $.env.get('TEMP')) || (await $.env.get('TMP')) || ''
    // One pet for all sessions, or (option) one each: then every session has its own status file.
    const sid = perSession ? `-${String(await $.session.id().catch(() => '')).replace(/[^\w-]/g, '').slice(0, 8)}` : ''
    statusPath = temp ? `${temp}\\mod-box-pet${sid}.txt` : ''
    sessionId = String(await $.session.id().catch(() => ''))
    if (perSession && sessionId) {
      const mine = (((await $.store.get(LOOKS_STORE).catch(() => null)) ?? {}) as Record<string, PetLook>)[sessionId]
      if (mine && PETS.includes(mine.pet)) look = mine
    }
    listenForLook($)
    listenForRecap($)
    listenForPrompt($)
    const now = (await $.clock.now()) || 1
    lastRequestAt = now
    isAsleep = await startsAsleep($, now)
    coldFor = isAsleep ? lastRequestAt : 0
    $.clock.every(POLL_MS, () => void poll($).catch(() => {}))
    project = base(await $.session.cwd().catch(() => ''))
    await $.command.register({ name: 'pet', description: t('Desktop-Pet: zeigen, verabschieden (stop) oder Figur wählen (z. B. /pet cat calico)', 'Desktop Pet: show it, send it off (stop) or pick a figure (e.g. /pet cat calico)'), argumentHint: '[stop | <figure> [coat]]' })
    if (isAsleep) {
      await say($, { kind: 'bye', title: titled(t('Cache ist kalt', 'Cache is cold')), text: t('Ich schlafe, bis du hier wieder schreibst.', "I'm asleep until you write here again.") })
      return r
    }
    void (async () => {
      await say($, { kind: 'hello', title: titled(t('Hallo!', 'Hello!')), text: t('Ich schaue Claude über die Schulter.', "I'm watching over Claude's shoulder.") })
      await ensure($)
    })().catch(() => {})
    return r
  })

  on('turn.start', {}, async ($, e, next) => {
    const r = await next(e)
    if ((e as { agentId?: string }).agentId) return r
    isTurnRunning = true
    await markRequest($)
    if (isAsleep && statusPath) {
      isAsleep = false
      void ensure($).catch(() => {})
    }
    steps = 0
    changed.clear()
    watchStepsUntil = 0
    lastDone = null
    // the last answer stays on a click, its buttons do not (the turn they answered is over)
    if (recap) recap = { kind: recap.kind === 'ask' ? 'done' : recap.kind, title: recap.title, text: recap.text }
    for (const key of [...pending.keys()]) if (key.startsWith('ns-')) pending.delete(key)
    if (e.text.trim()) void say($, { kind: 'work', title: titled(t('Los geht’s', 'On it')), text: cut(e.text, 120) })
    return r
  })

  on('tool.call', {}, async ($, e, next) => {
    if (!statusPath || (e as any).agentId) return next(e)
    const tool = String(e.tool)
    // Claude's question: its own hook puts it in the bubble; a "Using AskUserQuestion" here would
    // race it and could cover the choices.
    if (tool === 'AskUserQuestion' && askViaPet) return next(e)
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
    isTurnRunning = false
    await markRequest($)
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
    // An answer that ends by asking you something: the pet shows that question (it stays, like
    // Claude's own questions), with the summary in front when Haiku made one.
    const question = lastQuestion(e.answer)
    const isQuestion = question !== null
    const kind: PetKind = isQuestion ? 'ask' : 'done'
    const title = titled([isQuestion ? t('Frage an dich', 'A question for you') : t('Fertig', 'Done'), ...facts].join(' · '))
    const first = question ?? (gist(e.answer) || t('Fertig.', 'Done.'))
    lastDone = { kind, title, text: first }
    recap = { kind, title, text: compact(e.answer, question) || first }
    if (suggestViaPet && !isQuestion) watchStepsUntil = (await $.clock.now()) + 45_000
    void (async () => {
      await say($, { kind, title, text: first })
      // the summary and (for a closing question) reply buttons, both from Haiku, side by side
      const [said, offers] = await Promise.all([
        summary === 'haiku' && e.answer.trim().length > 200 ? sum($, e.answer).catch(() => null) : Promise.resolve(null),
        question && suggestViaPet ? replies($, e.answer, question).catch(() => [] as string[]) : Promise.resolve([] as string[]),
      ])
      // a new message came meanwhile: this answer is old news
      if (isTurnRunning || (!said && offers.length < 2)) return
      const text = said ? (question ? `${said}\n${question}` : said) : first
      lastDone = { kind, title, text }
      if (said) recap = { kind, title, text }
      if (offers.length < 2) return void (await say($, lastDone))
      const id = `ns-q${await $.clock.now()}`
      for (const key of [...pending.keys()]) if (key.startsWith('ns-')) pending.delete(key)
      pending.set(id, choice => void sendSuggestion($, choice))
      recap = { ...(recap ?? lastDone), ask: id, choices: offers, free: id }
      await say($, { ...lastDone, ask: id, choices: offers, free: id })
    })().catch(() => {})
    return r
  })

  // Claude's question: as buttons in the bubble too. Whichever answers first, the pet or the dialog
  // in Claude Code, counts; the other is closed (a hook returning while next is pending aborts it).
  on('tool.call', { tool: 'AskUserQuestion' }, async ($, e, next) => {
    const call = e as unknown as { questions?: AskQuestion[]; tool_use_id?: string; agentId?: string }
    if (!statusPath || !askViaPet || call.agentId) return next(e)
    const questions = call.questions ?? []
    const isPickable = questions.length > 0 && questions.every(q => !q.multiSelect && (((q.type ?? 'choice') === 'choice' && (q.options?.length ?? 0) >= 2) || (canType && q.type === 'text')))
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
      await say($, { kind: 'ask', title: ask(q), text: cut(q.question, 200), ask: id, choices: (q.options ?? []).map(o => o.label), free: id })
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

  // A permission request: shown, so it is not missed. With option permissions "answer" the bubble
  // offers "allow once" and "deny" for PERMIT_WAIT_S seconds; no rule is ever added ("always" stays
  // with Claude Code's dialog). Another hook's decision comes first; a dialog answered meanwhile
  // takes the buttons away again.
  on('classic.PermissionRequest', {}, async ($, e, next) => {
    const r = await next(e)
    const req = e as unknown as { tool_name?: string; tool_input?: Record<string, unknown> }
    if (!statusPath || !req.tool_name || (r as { decision?: unknown })?.decision) return r
    // Claude Code opens its question dialog through a permission request too: the question's own
    // hook shows its choices, an "allow" here would skip the question unanswered.
    if (req.tool_name === 'AskUserQuestion') return r
    // A plan to approve is the person's decision in Claude Code alone: shown, never answered here.
    const isPersonal = PERSONAL_TOOLS.includes(req.tool_name)
    const what = describe(req.tool_name, req.tool_input ?? {}, lang === 'de')
    const title = titled(t('Genehmigung nötig', 'Permission needed'))
    if (permissions !== 'answer' || isPersonal) {
      void say($, { kind: 'ask', title, text: `${what} · ${t('bitte in Claude Code bestätigen', 'please confirm in Claude Code')}` })
      return r
    }
    const allow = t('Einmal erlauben', 'Allow once')
    const deny = t('Ablehnen', 'Deny')
    const id = `perm-${(await $.clock.now()).toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    await say($, { kind: 'ask', title, text: what, ask: id, choices: [allow, deny] })
    const gone = () => void say($, { kind: 'work', title: titled(t('Arbeite', 'Working')), text: t('In Claude Code beantwortet.', 'Answered in Claude Code.') })
    next.signal?.addEventListener('abort', gone)
    const env = { PET_ANSWER: `${statusPath}.answer`, PET_STATUS: statusPath, PET_ID: id, PET_WAIT: String(PERMIT_WAIT_S) }
    const run = await $.process
      .run(['powershell', '-NoProfile', '-NonInteractive', '-Command', WAIT], { env, timeoutMs: (PERMIT_WAIT_S + 15) * 1000 })
      .catch(() => null)
    next.signal?.removeEventListener('abort', gone)
    const picked = run && run.exitCode === 0 ? parseAnswer(run.stdout) : null
    const choice = picked && picked.id === id ? picked.choice : null
    if (choice === allow) {
      void say($, { kind: 'work', title: titled(t('Erlaubt', 'Allowed')), text: what })
      return { ...r, decision: { behavior: 'allow' } } as typeof r
    }
    if (choice === deny) {
      void say($, { kind: 'error', title: titled(t('Abgelehnt', 'Denied')), text: what })
      return { ...r, decision: { behavior: 'deny', message: t('Im Desktop-Pet abgelehnt.', 'Denied in the desktop pet.') } } as typeof r
    }
    // no click in time: the dialog decides, as without the pet
    if (!next.signal?.aborted) void say($, { kind: 'ask', title, text: `${what} · ${t('bitte in Claude Code bestätigen', 'please confirm in Claude Code')}` })
    return r
  })

  on('command.run', { command: 'pet' }, async ($, e) => {
    if (!isWindows) return { text: t('Das Desktop-Pet gibt es nur unter Windows.', 'The desktop pet is Windows only.') }
    const [first = '', second = ''] = String(e.args ?? '').trim().toLowerCase().split(/\s+/)
    const next = parseLook(String(e.args ?? ''), look)
    if (first !== 'stop') isAsleep = false
    if (next) {
      await ensure($)
      await applyLook($, next, first, second !== '')
      const name = `${look.pet}${look.fur !== 'auto' ? ` (${look.fur})` : ''}`
      return { text: perSession ? t(`Das Pet dieser Sitzung ist jetzt: ${name}.`, `This session's pet is now: ${name}.`) : t(`Das Pet ist jetzt: ${name}.`, `The pet is now: ${name}.`) }
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
