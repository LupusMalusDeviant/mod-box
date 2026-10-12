// Subagent Saver: search-type subagents (Explore by default) that were given no model of their own
// run on a cheaper one instead of inheriting the main model. They start their own context, so the
// main conversation's prompt cache is untouched. An explicit model, forks, teammates, workflow
// agents and agents from plugins are always left alone.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { SaverStats } from '../types'
import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'

const stats = atom({ plugin: 'mod-box', key: 'ss_stats' } as const, { routed: 0, last: '' } as SaverStats)

let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)

// Cheapest first; a model is only ever swapped for one further left.
const RANK = ['haiku', 'sonnet', 'opus', 'fable']

/** Where a model id or alias sits in RANK; -1 when unknown. */
export function rankOf(model: string): number {
  const m = model.toLowerCase()
  return RANK.findIndex(r => m.includes(r))
}

export type SpawnFacts = {
  subagentType: string
  model?: string
  parentModel: string
  fork: boolean
  isTeammate?: true
  workflow?: unknown
  provider: { plugin: string }
}

/** The model to start this subagent on, or null to leave the spawn as it is. */
export function cheaperModel(e: SpawnFacts, target: string, types: string[]): string | null {
  if (target === 'off' || rankOf(target) < 0) return null
  if (e.fork || e.isTeammate || e.workflow || e.model) return null
  if (e.provider.plugin !== 'engine' || !types.includes(e.subagentType)) return null
  const parent = rankOf(e.parentModel)
  // Unknown parent models are left alone; so is a parent that is already as cheap.
  if (parent < 0 || parent <= rankOf(target)) return null
  return target
}

export const register: Register = (on, options) => {
  lang = options.language === 'de' ? 'de' : 'en'
  const target = String(options.model ?? 'sonnet')
  const types = String(options.types ?? 'Explore')
    .split(',')
    .map(x => x.trim())
    .filter(Boolean)

  // Claude Code's own setting wins: with CLAUDE_CODE_SUBAGENT_MODEL set, the mod stays out, so two
  // rules never pick a subagent's model against each other.
  let builtIn: string | null = null
  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    builtIn = ((await $.env.get('CLAUDE_CODE_SUBAGENT_MODEL').catch(() => undefined)) ?? '').trim() || null
    return r
  })

  on('agent.spawn', {}, async ($, e, next) => {
    if (builtIn) return next(e)
    const model = cheaperModel(e as SpawnFacts, target, types)
    if (!model) return next(e)
    await update($, stats, s => ({ routed: s.routed + 1, last: `${e.subagentType} → ${model}` }))
    return next({ ...e, model })
  })

  // Band manager: hand this mod's display to the Mod Box.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!e.props.hasSurvey) {
      const part = await band($, e).catch(() => null)
      if (part) offerBand(e, part)
    }
    return rest
  })
}

export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  const s = await read($, stats)
  if (!s.routed) return null
  const { Text } = $.ui.resolve(e)
  const text = `🤖 ${s.last}${s.routed > 1 ? ` (${s.routed}×)` : ''}`
  return {
    id: 'subagentSaver',
    urgent: false,
    short: <Text color="suggestion">{text}</Text>,
    line: (
      <Text>
        <Text color="suggestion">{text}</Text>
        <Text color="inactive">{t('  Subagenten auf dem günstigeren Modell', '  subagents on the cheaper model')}</Text>
      </Text>
    ),
    actions: [],
    status: text,
  }
}
