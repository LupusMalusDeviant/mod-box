// Cache Meter: one line above the prompt (through the Mod Box band manager) with
// 1. how long the prompt cache stays warm (countdown from the last request),
// 2. the last turn's hit rate (how much came from the cache),
// 3. how full the context window is, as weather (sun to thunderstorm), with its trend over the
//    last 12 turns as a sparkline (idea from token-weather in anthropics/claude-code-playground),
// 4. the plan's rate-limit windows (5 h / week),
// 5. keep-warm and the cold-send guard of Cache Tax, which runs embedded here (no band of its own):
//    a "keep warm" button, the cost of a cold resend, and the guard that stops one cold send.
// Plus a compact button that does what /compact does.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { register as cacheTax, taxInfo } from '../../cache-tax/hooks/register'
import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'
import type { MeterInfo } from '../types'

const info = atom({ plugin: 'cache-meter', key: 'info' } as const, {
  lastAt: 0,
  hit: null,
  percent: null,
  tokens: null,
  window: null,
  limits: [],
  trend: [],
} as MeterInfo)
// A tick so the countdown moves without a new turn.
const tick = atom({ plugin: 'cache-meter', key: 'tick' } as const, 0)

const TICK_MS = 15_000
const TREND_TURNS = 12

// Display language and options (module level: band() runs from the band manager).
let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
let ttlMs = 60 * 60_000
let showLimits = true
let keepWarmMs = 3 * 60 * 60_000

const STORE_AUTOCOMPACT = 'autocompact-by-box'

/** Tokens for Claude Code's autoCompactWindow setting, or null for its own default. */
export function autoCompactTokens(choice: string): number | null {
  const n = Number(choice.replace(/k$/i, '')) * 1000
  return Number.isFinite(n) && n >= 100000 && n <= 1000000 ? n : null
}

// Writes the chosen window into ~/.claude/settings.json (Claude Code watches that file). Only a
// value the box itself wrote is ever removed again, so a hand-set one stays.
async function applyAutoCompact($: EngineInterface, choice: string) {
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
  if (!home) return
  const path = `${home}/.claude/settings.json`
  const s = JSON.parse(String(await $.fs.read(path))) as Record<string, unknown>
  const want = autoCompactTokens(choice)
  const ours = await $.store.get(STORE_AUTOCOMPACT)
  if (want === null) {
    if (ours === null || ours === undefined || s.autoCompactWindow !== ours) return
    delete s.autoCompactWindow
    await $.store.delete(STORE_AUTOCOMPACT)
  } else {
    if (s.autoCompactWindow === want) return
    s.autoCompactWindow = want
    await $.store.set(STORE_AUTOCOMPACT, want)
  }
  await $.fs.write(path, JSON.stringify(s, null, 2) + '\n')
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

  ttlMs = (Number(options.ttlMinutes) || 60) * 60_000
  showLimits = options.limits !== 'off'
  keepWarmMs = (Number(options.keepWarmHours) || 3) * 60 * 60_000
  lang = options.language === 'de' ? 'de' : 'en'

  // Cache Tax runs inside: the guard (stop|warn|off) and auto keep-warm after a paid cold write.
  const guard = options.guard === 'warn' ? 'warn' : options.guard === 'off' ? 'off' : 'refuse'
  cacheTax(on, { embedded: true, guard, autoWarm: options.autoWarm === 'on' })

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    await refreshContext($)
    await applyAutoCompact($, String(options.autoCompact ?? 'auto')).catch(() => {})
    $.clock.every(TICK_MS, () => void update($, tick, n => (n ?? 0) + 1).catch(() => {}))
    return r
  })

  // Every request of the main loop writes (or reads) the cache: the clock starts here.
  on('turn.step', {}, async function* ($, e, next) {
    if (!e.agentId) {
      const now = await $.clock.now()
      await update($, info, i => ({ ...i, lastAt: now }))
    }
    yield* next(e)
  })

  on('turn.complete', {}, async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const u = e.usage
    const now = await $.clock.now()
    let hit: number | null = null
    if (u) {
      const total = u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens
      hit = total > 0 ? Math.round((u.cache_read_input_tokens / total) * 100) : null
    }
    await update($, info, i => ({ ...i, hit, lastAt: i.lastAt || now }))
    await refreshContext($)
    await addTrendPoint($)
    return r
  })

  // After a compact the old cache is worthless: clock back, re-read the context.
  on('session.compact', {}, async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      await update($, info, i => ({ ...i, lastAt: 0, hit: null }))
      await refreshContext($)
      await addTrendPoint($)
    }
    return r
  })
}

// For the Mod Box band manager (instead of an own AbovePrompt hook).
export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  const i = await read($, info)
  await read($, tick) // subscribes to the tick
  const now = await $.clock.now()
  const tax = taxInfo(now)
  const { Text, Button } = $.ui.resolve(e)

  const left = i.lastAt ? i.lastAt + ttlMs - now : 0
  const isCold = !!i.lastAt && left <= 0
  const cacheColor = !i.lastAt ? undefined : isCold ? 'red' : left < 10 * 60_000 ? 'yellow' : 'green'
  const cacheWord = !i.lastAt ? '—' : isCold ? t('kalt', 'cold') : `${fmtMin(left)}`
  const coldCost = isCold && tax?.coldUsd != null && tax.ctx > 0 ? ` ≈ ${fmtUsd(tax.coldUsd)}` : ''

  const cache = (
    <Text>
      {'Cache '}
      <Text color={cacheColor} bold>{!i.lastAt ? '—' : isCold ? t('kalt', 'cold') : 'warm'}</Text>
      {!i.lastAt ? null : isCold ? (
        <Text dimColor>{t(` · nächste Nachricht liest alles neu${coldCost}`, ` · next message re-reads everything${coldCost}`)}</Text>
      ) : (
        <Text dimColor>{t(` noch ${fmtMin(left)}`, ` ${fmtMin(left)} left`)}</Text>
      )}
    </Text>
  )
  const warmKept = tax?.isWarmKept ? (
    <Text>
      {'  ·  '}
      <Text color="cyan">{t(`🔥 warm gehalten ${fmtMin(tax.keptLeftMs)}`, `🔥 kept warm ${fmtMin(tax.keptLeftMs)}`)}</Text>
      {tax.nextPingMs != null ? <Text dimColor>{t(` · Ping in ${fmtMin(tax.nextPingMs)}`, ` · ping in ${fmtMin(tax.nextPingMs)}`)}</Text> : null}
    </Text>
  ) : tax?.stopped ? (
    <Text dimColor>{t(`  ·  Warmhalten gestoppt: ${tax.stopped}`, `  ·  keep-warm stopped: ${tax.stopped}`)}</Text>
  ) : null
  const hit = i.hit == null ? null : (
    <Text>
      {t('  ·  Treffer ', '  ·  hits ')}
      <Text color={i.hit >= 80 ? 'green' : i.hit >= 40 ? 'yellow' : 'red'}>{`${i.hit}%`}</Text>
    </Text>
  )
  const pct = i.percent
  const ctx = pct == null ? null : (
    <Text>
      {`  ·  ${weather(pct)} ${t('Kontext', 'context')} `}
      <Text color={pct < 50 ? 'green' : pct < 75 ? 'yellow' : 'red'} bold>{`${pct}%`}</Text>
      {i.tokens != null && i.window ? <Text dimColor>{` (${fmtTok(i.tokens)}/${fmtTok(i.window)})`}</Text> : null}
      {(i.trend ?? []).length >= 2 ? <Text color={pct < 50 ? 'green' : pct < 75 ? 'yellow' : 'red'} dimColor>{` ${sparkline(i.trend)}`}</Text> : null}
      {trendText(i.trend ?? []) ? <Text dimColor>{` ${trendText(i.trend ?? [])}`}</Text> : null}
    </Text>
  )
  const limits = showLimits && i.limits?.length ? (
    <Text>
      {t('  ·  Abo ', '  ·  plan ')}
      {i.limits.map((l, n) => (
        <Text key={`cm-l-${n}`}>
          {n > 0 ? ' ' : ''}
          <Text dimColor>{`${limitName(l.kind)} `}</Text>
          <Text color={l.percentUsed < 60 ? 'green' : l.percentUsed < 85 ? 'yellow' : 'red'}>{`${Math.round(l.percentUsed)}%`}</Text>
        </Text>
      ))}
    </Text>
  ) : null

  const actions: unknown[] = []
  if (!e.props?.isWorking && (pct ?? 0) >= 30) actions.push(<Button key="cm-compact" label="Compact" plain onPress={() => void compact($)} />)
  if (tax && !e.props?.isWorking && i.lastAt) {
    actions.push(
      tax.isWarmKept ? (
        <Button key="cm-warm-off" label={t('Warmhalten aus', 'Stop keep-warm')} plain onPress={() => void keepWarm($, 'off')} />
      ) : (
        <Button key="cm-warm" label={t(`Warm halten ${fmtMin(keepWarmMs)}`, `Keep warm ${fmtMin(keepWarmMs)}`)} plain onPress={() => void keepWarm($, `${Math.round(keepWarmMs / 3_600_000)}h`)} />
      ),
    )
  }

  const shortWeather = pct == null ? '' : ` ${weather(pct)} ${pct}%`
  return {
    id: 'cacheMeter',
    urgent: false,
    short: (
      <Text>
        <Text color={cacheColor} bold>{`⏱ ${cacheWord}`}</Text>
        {tax?.isWarmKept ? <Text color="cyan">{' 🔥'}</Text> : null}
        <Text>{shortWeather}</Text>
      </Text>
    ),
    line: (
      <Text>
        {cache}
        {warmKept}
        {hit}
        {ctx}
        {limits}
      </Text>
    ),
    actions,
    status: `Cache ${cacheWord}${tax?.isWarmKept ? ' 🔥' : ''}${shortWeather}`,
  }
}

// Keep-warm runs in the embedded Cache Tax; its /keepwarm command switches it ($ may not cross an import).
async function keepWarm($: EngineInterface, args: string) {
  await $.command.run({ command: 'keepwarm', args }).catch(() => $.ui.toast(t(`Bitte /keepwarm ${args} eingeben.`, `Please type /keepwarm ${args}.`)))
}

async function refreshContext($: EngineInterface) {
  const usage = await $.session.usage().catch(() => null)
  if (!usage) return
  const { context, rateLimits } = usage
  await update($, info, i => ({
    ...i,
    percent: context.percent ?? null,
    tokens: context.tokens ?? null,
    window: context.window || null,
    limits: (rateLimits ?? []).map(l => ({ kind: l.kind, percentUsed: l.percentUsed, ...(l.resetsAt ? { resetsAt: l.resetsAt } : {}) })),
  }))
}

async function addTrendPoint($: EngineInterface) {
  await update($, info, i => (i.percent == null ? i : { ...i, trend: [...(i.trend ?? []), i.percent].slice(-TREND_TURNS) }))
}

const BARS = '▁▂▃▄▅▆▇█'
/** The context fill of the last turns as one bar each, on a fixed 0–100 % scale. */
export function sparkline(points: number[]): string {
  return points.map(p => BARS[Math.min(BARS.length - 1, Math.max(0, Math.floor((p / 100) * BARS.length)))]).join('')
}

/** Average growth per turn over the trend, and how many turns are left at that pace (no compact in between). */
export function trendText(points: number[]): string {
  const steps = points.slice(1).map((p, n) => p - points[n]!).filter(d => d >= 0)
  if (steps.length < 2) return ''
  const per = steps.reduce((a, b) => a + b, 0) / steps.length
  if (per < 0.5) return t('· stabil', '· steady')
  const left = Math.floor((100 - points[points.length - 1]!) / per)
  return t(`· +${per.toFixed(1)}%/Runde, voll in ~${left}`, `· +${per.toFixed(1)}%/turn, full in ~${left}`)
}

// five_hour -> 5h, seven_day -> week, everything else stays readable.
export function limitName(kind: string): string {
  if (/five_hour|5h/i.test(kind)) return '5h'
  if (/seven_day_opus/i.test(kind)) return t('Woche Opus', 'week Opus')
  if (/seven_day_sonnet/i.test(kind)) return t('Woche Sonnet', 'week Sonnet')
  if (/seven_day|week/i.test(kind)) return t('Woche', 'week')
  return kind.replace(/_/g, ' ')
}

async function compact($: EngineInterface) {
  $.ui.toast(t('Sitzung wird komprimiert …', 'Compacting the session …'))
  try {
    const before = (await read($, info)).tokens
    const r = await $.session.compact()
    if ('skip' in r && r.skip) {
      $.ui.toast(t('Compact wurde von einem Hook abgelehnt.', 'A hook refused the compact.'))
      return
    }
    await refreshContext($)
    const after = (await read($, info)).tokens
    $.ui.toast(
      before != null && after != null
        ? t(`Komprimiert: ${fmtTok(Math.max(0, before - after))} Token gespart.`, `Compacted: ${fmtTok(Math.max(0, before - after))} tokens saved.`)
        : t('Komprimiert.', 'Compacted.'),
    )
  } catch {
    $.ui.toast(t('Compact geht nur zwischen zwei Runden.', 'Compact only works between turns.'))
  }
}

export function weather(pct: number): string {
  return pct < 40 ? '☀' : pct < 60 ? '⛅' : pct < 80 ? '🌧' : '⛈'
}

export function fmtMin(ms: number): string {
  const m = Math.max(0, Math.ceil(ms / 60_000))
  return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}` : `${m} min`
}

function fmtTok(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function fmtUsd(usd: number): string {
  return '$' + (usd >= 100 ? usd.toFixed(0) : usd.toFixed(2))
}
