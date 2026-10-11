// Heads-up (a rebuild of "You Should Know"): after a longer answer a small model
// reads it again and pulls out an easily missed but important point
// (risk, side effect, open decision, manual step) as a band above the prompt.
// "Tell me more" puts a follow-up question into the prompt (nothing is sent by itself),
// "Got it" hides the point.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HeadsUp } from '../types'
import { addUsage, USAGE_STORE } from '../../settings/hooks/usage'
import type { UsageBook } from '../../settings/hooks/usage'
import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'

const note = atom({ plugin: 'mod-box', key: 'hu_note' } as const, null as HeadsUp | null)

const MODEL = 'haiku'

// Display language (options.language: de | en)
let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
const MIN_ANSWER = 400 // short answers hide nothing
const MAX_KEPT = 240

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

  const language = String(options?.language || 'de')
  lang = language === 'de' ? 'de' : 'en'
  let latest = ''

  on('prompt.submit', {}, async ($, e, next) => {
    latest = `submit-${await $.clock.now()}`
    await update($, note, () => null)
    return next(e)
  })

  on('turn.start', {}, async ($, e, next) => {
    latest = e.turnId
    await update($, note, () => null)
    return next(e)
  })

  on('turn.complete', {}, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    latest = e.turnId
    if (e.reason !== 'answer' || e.answer.trim().length < MIN_ANSWER) return r
    void scan($, e.turnId, e.answer, () => latest, language).catch(() => {})
    return r
  })

}

// Mod Box: token usage of this mod's own model calls, for the window (session in $.state,
// total in $.store). $ stays in this file; usage.ts only does the arithmetic.
const USAGE = { plugin: 'mod-box', key: 'mb_usage' } as const
async function recordUsage($: EngineInterface, model: string, u: Parameters<typeof addUsage>[3] | undefined) {
  if (!u) return
  await update($, USAGE, b => addUsage(b, 'headsUp', model, u)).catch(() => {})
  const total = await $.store.get(USAGE_STORE).catch(() => null)
  await $.store.set(USAGE_STORE, addUsage(total as UsageBook | null, 'headsUp', model, u)).catch(() => {})
}

async function scan($: EngineInterface, turnId: string, answer: string, current: () => string, language: string) {
  const r = await $.model.complete({
    model: MODEL,
    maxTokens: 150,
    timeoutMs: 20_000,
    system:
      'You review a coding assistant\'s reply on behalf of a busy reader who skims. ' +
      'Find the ONE point the reader would most regret missing: a risk, a destructive or irreversible side effect, ' +
      'a security or cost issue, a manual step they must do, a decision they must make, or something that was NOT done or did NOT work ' +
      'although the reply may read as success. Only if such a point exists AND it is easy to overlook (buried in a list, a side clause, the end). ' +
      `Reply with that single point as one plain sentence under 200 characters, in ${language === 'en' ? 'English' : 'German'}, ` +
      'without a prefix like "Heads up". If there is nothing like that, reply with the single word NONE.',
    prompt: `<reply>\n${answer.slice(0, 6000)}\n</reply>`,
  })
  await recordUsage($, MODEL, r.usage)
  if (!r.isAnswered) return
  const text = r.text.trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^(heads up|achtung|hinweis)\s*[:,-]\s*/i, '')
  if (!text || /^none\b/i.test(text) || text.length > MAX_KEPT) return
  await update($, note, before => (current() !== turnId ? before : { turnId, text }))
}

// For the Mod Box band manager (instead of an AbovePrompt hook of its own).
export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  const n = await read($, note)
  if (!n || e.props?.isWorking) return null
  const { Text, Button } = $.ui.resolve(e)
  return {
    id: 'headsUp',
    urgent: true,
    short: <Text color="yellow" bold>{'⚠ Heads up'}</Text>,
    line: (
      <Text wrap="wrap">
        <Text color="yellow" bold>{'⚠ Heads up: '}</Text>
        <Text>{n.text}</Text>
      </Text>
    ),
    actions: [
      <Button
        key="hu-more"
        label={t('Mehr dazu', 'Tell me more')}
        plain
        onPress={async () => {
          await $.prompt.fill({ text: `Explain this point in more detail: ${n.text}${lang === 'en' ? '' : ' Answer in German.'}`, mode: 'replace' })
          await update($, note, () => null)
        }}
      />,
      <Button key="hu-ok" label={t('Verstanden', 'Got it')} plain onPress={() => void update($, note, () => null)} />,
    ],
    status: `⚠ ${n.text}`,
  }
}
