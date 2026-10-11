// Handoff note: so a new session doesn't have to re-read the whole old history at high cost.
// /handoff asks the model, over its own history (through the warm cache, so cheaply),
// for a handoff and writes it to <project>/.claude/handoff.local.md.
// A new session finds the note and offers "Continue" (puts the request into the prompt).
// Automatic (option): shortly before the cache goes cold while the context is large.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Handoff } from '../types'
import { addUsage, USAGE_STORE } from '../../settings/hooks/usage'
import type { UsageBook } from '../../settings/hooks/usage'
import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'

const note = atom({ plugin: 'mod-box', key: 'ho_note' } as const, null as Handoff | null)
const text = atom({ plugin: 'mod-box', key: 'ho_text' } as const, '')
const busy = atom({ plugin: 'mod-box', key: 'ho_busy' } as const, false)

const FILE = '.claude/handoff.local.md'

// Display language (options.language: de | en)
let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
const PANE = 'handoff'
const MAX_AGE_MS = 14 * 24 * 60 * 60_000
const AUTO_BEFORE_COLD_MS = 6 * 60_000
const AUTO_MIN_TOKENS = 40_000

// Instructions to Claude are English; the note is for the next Claude session, so it is English too.
export function handoffPrompt(_lang: string): string {
  return (
    'Write a handoff note for a new Claude Code session that continues this work without the prior transcript. ' +
    'Markdown, concise, with these sections: "## Goal", "## Done" (with file paths), "## Current state", ' +
    '"## Open / next steps" (concrete, in order), "## Good to know" (decisions, pitfalls, commands, user preferences). ' +
    'No preamble, start with the first heading. Do not invent: mark what is unclear as open.'
  )
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

  lang = options.language === 'de' ? 'de' : 'en'
  const isAuto = options.auto === 'on'
  const ttlMs = (Number(options.ttlMinutes) || 60) * 60_000
  let lastAt = 0
  let autoDoneFor = 0

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'handoff', description: t('Übergabe-Notiz für die nächste Sitzung schreiben (.claude/handoff.local.md)', 'Write a handoff note for the next session (.claude/handoff.local.md)') })
    await offer($)
    if (isAuto) {
      $.clock.every(60_000, () => {
        void (async () => {
          const now = await $.clock.now()
          if (!lastAt || autoDoneFor === lastAt || (await read($, busy))) return
          const left = lastAt + ttlMs - now
          if (left > AUTO_BEFORE_COLD_MS || left < 30_000) return
          const { context } = await $.session.usage()
          if ((context.tokens ?? 0) < AUTO_MIN_TOKENS) return
          autoDoneFor = lastAt
          await write($, lang, true)
        })().catch(() => {})
      })
    }
    return r
  })

  on('turn.step', {}, async function* ($, e, next) {
    if (!e.agentId) lastAt = await $.clock.now()
    yield* next(e)
  })

  on('command.run', { command: 'handoff' }, async $ => {
    const r = await write($, lang, false)
    return { text: r }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Markdown } = $.ui.resolve(e) as any
    const n = await read($, note)
    const t = await read($, text)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>{n ? `${n.path} · ${fmtDate(n.at)}` : FILE}</Text>
        {Markdown ? <Markdown key="ub-md" text={t || '(leer)'} /> : <Text>{t || '(leer)'}</Text>}
      </Box>
    )
  })
}

async function offer($: EngineInterface) {
  const cwd = await $.session.cwd()
  const path = `${cwd}/${FILE}`
  if (!(await $.fs.exists(path))) return
  const st = await $.fs.stat(path).catch(() => null)
  const now = await $.clock.now()
  if (!st || now - st.mtimeMs > MAX_AGE_MS) return
  // Offer it only to a fresh session, not in the middle of a running one.
  const msgs = await $.session.messages().catch(() => [])
  if (msgs.some(m => m.role === 'assistant')) return
  const body = String(await $.fs.read(path))
  await update($, text, () => body)
  await update($, note, () => ({ path, at: st.mtimeMs, preview: preview(body), kind: 'gefunden', isDismissed: false }))
}

// Mod Box: token usage of this mod's own model calls, for the window (session in $.state,
// total in $.store). $ stays in this file; usage.ts only does the arithmetic.
const USAGE = { plugin: 'mod-box', key: 'mb_usage' } as const
async function recordUsage($: EngineInterface, model: string, u: Parameters<typeof addUsage>[3] | undefined) {
  if (!u) return
  await update($, USAGE, b => addUsage(b, 'handoff', model, u)).catch(() => {})
  const total = await $.store.get(USAGE_STORE).catch(() => null)
  await $.store.set(USAGE_STORE, addUsage(total as UsageBook | null, 'handoff', model, u)).catch(() => {})
}

async function write($: EngineInterface, lang: string, isAuto: boolean): Promise<string> {
  if (await read($, busy)) return t('Übergabe wird schon geschrieben.', 'The handoff is already being written.')
  await update($, busy, () => true)
  try {
    const r = await $.model.fork({ prompt: handoffPrompt(lang) })
    await recordUsage($, await $.session.model().catch(() => ''), 'usage' in r ? r.usage : undefined)
    if (!r.isAnswered) {
      const why = r.reason === 'nothing-to-fork' ? t('In dieser Sitzung gibt es noch nichts zu übergeben.', 'Nothing to hand off in this session yet.') : t(`Das Modell hat nicht geantwortet (${r.reason}).`, `The model did not answer (${r.reason}).`)
      if (!isAuto) $.ui.toast(why)
      return why
    }
    const cwd = await $.session.cwd()
    const now = await $.clock.now()
    const path = `${cwd}/${FILE}`
    const body = `<!-- Mod Box handoff note, ${new Date(now).toISOString()}${isAuto ? ', written automatically before the cache expired' : ''} -->\n\n${r.text.trim()}\n`
    await $.fs.write(path, body)
    await update($, text, () => body)
    await update($, note, () => ({ path, at: now, preview: preview(body), kind: 'geschrieben', isDismissed: false }))
    const cached = r.usage.cache_read_input_tokens
    const msg = t(
      `Übergabe geschrieben: ${FILE}${cached ? ` (${Math.round(cached / 1000)}k Token aus dem Cache)` : ''}. Eine neue Sitzung in diesem Ordner bietet "Weitermachen" an.`,
      `Handoff written: ${FILE}${cached ? ` (${Math.round(cached / 1000)}k tokens from the cache)` : ''}. A new session in this folder offers "Continue".`,
    )
    $.ui.toast(msg)
    return msg
  } finally {
    await update($, busy, () => false)
  }
}

export function preview(body: string): string {
  const line = body
    .split('\n')
    .map(l => l.trim())
    .find(l => l && !l.startsWith('<!--') && !l.startsWith('#'))
  return (line ?? '').replace(/^[-*]\s*/, '').slice(0, 100)
}

function fmtDate(ms: number): string {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getDate())}.${p(d.getMonth() + 1)}. ${p(d.getHours())}:${p(d.getMinutes())}`
}

// For the Mod Box band manager (instead of an AbovePrompt hook of its own).
export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  const n = await read($, note)
  if (!n || n.isDismissed || e.props?.isWorking) return null
  const { Text, Button } = $.ui.resolve(e)
  const when = fmtDate(n.at)
  const head = n.kind === 'gefunden' ? t(`Übergabe vom ${when} gefunden: `, `Handoff from ${when} found: `) : t(`Übergabe geschrieben (${when}): `, `Handoff written (${when}): `)
  const actions: unknown[] = []
  if (n.kind === 'gefunden') {
    actions.push(
      <Button
        key="ub-weiter"
        label={t('Weitermachen', 'Continue')}
        plain
        onPress={async () => {
          await $.prompt.fill({ text: `Read ${FILE} (the last session's handoff) and continue where it stopped. First sum up in two sentences where we stand.${lang === 'en' ? '' : ' Answer in German.'}`, mode: 'replace' })
          await update($, note, x => (x ? { ...x, isDismissed: true } : x))
        }}
      />,
    )
  }
  actions.push(<Button key="ub-ansehen" label={t('Ansehen', 'View')} plain onPress={() => void $.ui.open({ id: PANE, title: t('Übergabe-Notiz', 'Handoff note'), focus: true, closeOnEscape: true })} />)
  actions.push(<Button key="ub-weg" label="×" plain onPress={() => void update($, note, x => (x ? { ...x, isDismissed: true } : x))} />)
  return {
    id: 'handoff',
    urgent: n.kind === 'gefunden',
    short: <Text color="cyan">{t('📋 Übergabe', '📋 handoff')}</Text>,
    line: (
      <Text>
        <Text color="cyan" bold>{'📋 '}</Text>
        <Text>{head}</Text>
        <Text dimColor>{n.preview}</Text>
      </Text>
    ),
    actions,
    status: `📋 ${head}${n.preview}`,
  }
}
