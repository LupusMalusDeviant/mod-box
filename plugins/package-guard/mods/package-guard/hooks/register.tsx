// Package Guard: before Claude installs (or runs, via npx and the like) a package from npm, PyPI or
// crates.io, it asks the public registry about it. It holds the command when the package does not
// exist (a made-up name), is only days old, or looks like a well-known package and is young or thin
// (typosquatting). Everything else goes through untouched. The person allows a held package in
// the band; Claude then installs it again.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PackageHold, PackageInfo } from '../types'
import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'
import { type Ecosystem, wantedPackages } from './parse'
import { lookalike } from './similar'

const hold = atom({ plugin: 'package-guard', key: 'hold' } as const, null as PackageHold | null)
const allowed = atom({ plugin: 'package-guard', key: 'allowed' } as const, [] as string[])

let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
let mode = 'block'
const known = new Map<string, PackageInfo>()

const DAY = 86_400_000
const NEW_DAYS = 14
const YOUNG_DAYS = 180
const FEW_VERSIONS = 5

/** Why a package is suspicious; empty when it is fine. Pure, for the tests. */
export function reasonsFor(eco: Ecosystem, name: string, info: PackageInfo | null, now: number, de = false): string[] {
  const tr = (a: string, b: string) => (de ? a : b)
  const like = lookalike(eco, name)
  if (!info || info.error) return like ? [tr(`ähnelt „${like}“ (Registry nicht erreichbar)`, `looks like "${like}" (registry not reachable)`)] : []
  if (info.exists === false) return [tr('gibt es in der Registry nicht (erfundener Name?)', 'does not exist in the registry (a made-up name?)')]
  // npm replaces removed malware with "0.0.1-security" from npm/security-holder.
  if (/-security$/.test(info.latest ?? '') || /security-holder/.test(info.repo ?? '')) {
    return [tr('wurde als Schadpaket entfernt (npm-Sicherheitsplatzhalter)', 'was removed as malware (npm security placeholder)')]
  }
  const out: string[] = []
  const days = info.created ? Math.floor((now - Date.parse(info.created)) / DAY) : NaN
  // a date in the future means a wrong clock: no age then
  const age = Number.isFinite(days) && days >= 0 ? days : null
  if (age !== null && age < NEW_DAYS) out.push(tr(`erst ${age} Tag(e) alt`, `only ${age} day(s) old`))
  if (like && ((age !== null && age < YOUNG_DAYS) || (info.versions ?? 0) < FEW_VERSIONS)) {
    out.push(tr(`ähnelt „${like}“ (${info.versions ?? '?'} Versionen, ${age ?? '?'} Tage alt)`, `looks like "${like}" (${info.versions ?? '?'} versions, ${age ?? '?'} days old)`))
  }
  return out
}

async function lookup($: EngineInterface, eco: Ecosystem, name: string): Promise<PackageInfo | null> {
  const key = `${eco}:${name}`
  const cached = known.get(key)
  if (cached) return cached
  const script = `${$.plugin.root}/mods/package-guard/registry.mjs`.replace(/\\/g, '/')
  const r = await $.process.run(['node', script, eco, name], { timeoutMs: 15_000 }).catch(() => null)
  let info: PackageInfo | null = null
  try {
    info = JSON.parse((r?.stdout ?? '').trim().split('\n').pop() || 'null') as PackageInfo | null
  } catch {
    info = null
  }
  if (info && !info.error) known.set(key, info)
  return info
}

const label = (eco: Ecosystem) => (eco === 'npm' ? 'npm' : eco === 'pypi' ? 'PyPI' : 'crates.io')

export const register: Register = (on, options) => {
  lang = options.language === 'de' ? 'de' : 'en'
  mode = String(options.mode ?? 'block')

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    await $.command.register({ name: 'pkg-allow', description: t('Paket-Wächter: ein angehaltenes Paket erlauben', 'Package Guard: allow a held package'), argumentHint: '<name>' })
    return r
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const wanted = wantedPackages(String(e.command ?? ''))
    if (!wanted.length) return next(e)
    const ok = await read($, allowed)
    const now = await $.clock.now()
    const held: PackageHold['packages'] = []
    for (const p of wanted) {
      if (ok.includes(`${p.eco}:${p.name}`)) continue
      const info = await lookup($, p.eco, p.name)
      const reasons = reasonsFor(p.eco, p.name, info, now, lang === 'de')
      if (reasons.length) held.push({ eco: p.eco, name: p.name, runs: p.runs, reasons, repo: info?.repo ?? null })
    }
    if (!held.length) return next(e)
    const list = held.map(p => `${p.name} (${label(p.eco)}): ${p.reasons.join(', ')}`).join('; ')
    // Without a registry answer a look-alike is only worth a warning.
    const onlyUnsure = held.every(p => p.reasons.every(r => /registry not reachable|Registry nicht erreichbar/.test(r)))
    if (mode === 'warn' || onlyUnsure) {
      $.ui.toast(`📦 ${t('Paket-Wächter', 'Package Guard')}: ${list}`, { timeoutMs: 8000 })
      return next(e)
    }
    await update($, hold, () => ({ command: String(e.command ?? '').slice(0, 300), packages: held, at: now, isDismissed: false }))
    $.ui.toast(`📦 ${t('Paket-Wächter hat angehalten', 'Package Guard held')}: ${list}`, { timeoutMs: 8000 })
    return {
      deny:
        `Package Guard held this command and did not run it: ${list}. ` +
        'Check the name: it may be a typo of a well-known package or a package that does not exist. ' +
        'Tell the user what you found. If they confirm the package, they allow it in the band above the prompt (or with /pkg-allow <name>); then run the command again. Do not install it another way.',
    }
  })

  on('command.run', { command: 'pkg-allow' }, async ($, e) => {
    const name = String(e.args ?? '').trim().toLowerCase()
    const h = await read($, hold)
    const hits = (h?.packages ?? []).filter(p => !name || p.name === name)
    if (!hits.length) return { text: t('Kein angehaltenes Paket dieses Namens.', 'No held package by that name.') }
    await allow($, hits.map(p => `${p.eco}:${p.name}`))
    return { text: t(`Erlaubt: ${hits.map(p => p.name).join(', ')}. Claude kann den Befehl jetzt erneut ausführen.`, `Allowed: ${hits.map(p => p.name).join(', ')}. Claude can run the command again now.`) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!e.props.hasSurvey) {
      const part = await band($, e).catch(() => null)
      if (part) offerBand(e, part)
    }
    return rest
  })
}

async function allow($: EngineInterface, keys: string[]) {
  await update($, allowed, list => [...new Set([...list, ...keys])])
  await update($, hold, h => {
    if (!h) return h
    const rest = h.packages.filter(p => !keys.includes(`${p.eco}:${p.name}`))
    return rest.length ? { ...h, packages: rest } : null
  })
}

export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  const h = await read($, hold)
  if (!h || h.isDismissed || !h.packages.length) return null
  const { Text, Button } = $.ui.resolve(e)
  const names = h.packages.map(p => `${p.name} (${label(p.eco)}): ${p.reasons.join(', ')}`).join(' · ')
  const keys = h.packages.map(p => `${p.eco}:${p.name}`)
  return {
    id: 'packageGuard',
    urgent: true,
    short: <Text color="yellow">{`📦 ${h.packages.length}`}</Text>,
    line: (
      <Text>
        <Text color="yellow" bold>{'📦 '}</Text>
        <Text>{t('Paket angehalten: ', 'Package held: ')}</Text>
        <Text dimColor>{names}</Text>
      </Text>
    ),
    actions: [
      <Button key="pg-allow" label={t('Erlauben', 'Allow')} plain onPress={() => void allow($, keys).then(() => $.ui.toast(t('Erlaubt. Claude kann den Befehl jetzt erneut ausführen.', 'Allowed. Claude can run the command again now.')))} />,
      <Button key="pg-dismiss" label="×" plain onPress={() => void update($, hold, x => (x ? { ...x, isDismissed: true } : x))} />,
    ],
    status: `📦 ${names}`,
  }
}
