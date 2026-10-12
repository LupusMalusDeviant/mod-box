// Mod Box window (/mod-box), four tabs:
//  Mods      – every mod with its switch and its parameters; imported mods can be removed.
//  Profiles  – set many switches at once (default, lean, guards only, everything on).
//  Sources   – connected Claude marketplaces and own git links; import mods from them into the box.
// Texts follow the "language" setting (de/en). Switches and parameters go through $.config.set
// (like /config), which reloads the box. Importing, removing and scanning sources is done by
// tools/box.mjs (Node).
import { atom, read, update } from 'claude-code'
import type { ConfigRow, EngineInterface, Register } from 'claude-code'

import { openBand, takeBand } from './band'
import { sumBook, tokensOf, USAGE_STORE } from './usage'
import type { ModUsage, UsageBook } from './usage'
import { BAND_IDS } from './bands'
import { HOOKS } from './hooks-table'
import { CATALOG, GROUPS, PLUGIN, PROFILES, SETTINGS } from './catalog'
import type { CatalogField, CatalogMod, Text as I18n } from './catalog'
import type { NativeField, NativeInfo, NativePlugin, SourcePlugin, EnvCheck, HookError, ImportReport, Source, Tab, UpdateInfo } from '../types'

const PANE = 'mod-box-settings'
// How Claude Code names this plugin's /config rows: <plugin>.<field>, for an installed plugin often
// <plugin>@<marketplace>.<field>. Found from the list itself (see configRows); this is the first guess.
let PREFIX = PLUGIN + '.'
const STORE_LINKS = 'source-links'
const STORE_PENDING = 'profile-pending'
// The profile last applied, the mods the box has seen, and the imported mods the person trusts.
const STORE_ACTIVE = 'active-profile'
const STORE_SEEN = 'seen-mods'
const STORE_TRUSTED = 'trusted-mods'
const ROWS_PER_SOURCE = 12

const tab = atom({ plugin: 'mod-box', key: 'mb_tab' } as const, 'mods' as Tab)
const links = atom({ plugin: 'mod-box', key: 'mb_links' } as const, [] as string[])
const sources = atom({ plugin: 'mod-box', key: 'mb_sources' } as const, null as Source[] | null)
const loadedAt = atom({ plugin: 'mod-box', key: 'mb_loadedAt' } as const, 0)
const busy = atom({ plugin: 'mod-box', key: 'mb_busy' } as const, null as string | null)
const filter = atom({ plugin: 'mod-box', key: 'mb_filter' } as const, '')
const open = atom({ plugin: 'mod-box', key: 'mb_open' } as const, [] as string[])
const report = atom({ plugin: 'mod-box', key: 'mb_report' } as const, null as ImportReport | null)
// Natively managed plugins (tools/native.mjs) and their details, read when a row opens.
const natives = atom({ plugin: 'mod-box', key: 'mb_natives' } as const, null as NativePlugin[] | null)
const nativeInfo = atom({ plugin: 'mod-box', key: 'mb_nativeInfo' } as const, {} as Record<string, NativeInfo>)
const expanded = atom({ plugin: 'mod-box', key: 'mb_expanded' } as const, [] as string[])
// Mods that came in since the last session: marked "new" in the window for this session.
const fresh = atom({ plugin: 'mod-box', key: 'mb_fresh' } as const, [] as string[])
let version = ''
const updates = atom({ plugin: 'mod-box', key: 'mb_updates' } as const, null as UpdateInfo[] | null)
const usage = atom({ plugin: 'mod-box', key: 'mb_usage' } as const, {} as Record<string, ModUsage>)
const errors = atom({ plugin: 'mod-box', key: 'mb_errors' } as const, [] as HookError[])
const envChecks = atom({ plugin: 'mod-box', key: 'mb_envChecks' } as const, null as EnvCheck[] | null)
const validation = atom({ plugin: 'mod-box', key: 'mb_validation' } as const, null as { ok: boolean; text: string; at: number } | null)
const debugLines = atom({ plugin: 'mod-box', key: 'mb_debugLines' } as const, null as string[] | null)
const updatedAt = atom({ plugin: 'mod-box', key: 'mb_updatedAt' } as const, 0)
const diff = atom({ plugin: 'mod-box', key: 'mb_diff' } as const, null as { id: string; from: string; to: string; text: string } | null)

// ---------------------------------------------------------------- language and options

let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
const tx = (text: I18n | null | undefined) => (text ? (lang === 'en' ? text.en : text.de || text.en) : '')
const label = (f: CatalogField | undefined, value: string) => f?.labels?.[lang]?.[value] ?? value

// The core gets all options: switches, display per band mod, band layout and order.
let opts: Record<string, unknown> = {}

function toggleOn(toggle: string): boolean {
  const v = opts[toggle]
  if (typeof v === 'boolean') return v
  return CATALOG.find(m => m.toggle === toggle)?.default ?? false
}

function setting(key: string): string {
  const v = opts[key]
  if (typeof v === 'string' && v !== '') return v
  return String(SETTINGS.find(s => s.key === key)?.default ?? '')
}

export function showMode(toggle: string): 'band' | 'status' | 'off' {
  const v = opts[toggle + 'Show']
  return v === 'status' || v === 'off' ? v : 'band'
}

export function bandOrder(raw: string): string[] {
  const list = raw.split(',').map(s => s.trim()).filter(x => BAND_IDS.includes(x))
  return [...new Set([...list, ...BAND_IDS])]
}

export const register: Register = (on, options) => {
  opts = (options ?? {}) as Record<string, unknown>
  lang = opts.language === 'de' ? 'de' : 'en'

  // Diagnosis: as the outermost hooks of the box these read next.trace after the box's own hooks ran
  // and note every box hook that failed. Switch it off with the setting diagnose = off.
  if (setting('diagnose') !== 'off') {
    on('session.start', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('session.start', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('session.start', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('session.end', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('session.end', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('session.end', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('session.compact', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('session.compact', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('session.compact', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('turn.start', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('turn.start', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('turn.start', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('turn.complete', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('turn.complete', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('turn.complete', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('tool.call', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('tool.call', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('tool.call', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('prompt.submit', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('prompt.submit', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('prompt.submit', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('command.run', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('command.run', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('command.run', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('agent.spawn', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('agent.spawn', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('agent.spawn', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('config.set', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('config.set', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('config.set', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('ui.close', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('ui.close', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('ui.close', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('classic.SessionStart', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('classic.SessionStart', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('classic.SessionStart', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('classic.CwdChanged', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('classic.CwdChanged', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('classic.CwdChanged', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('classic.FileChanged', {}, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('classic.FileChanged', next.trace)
        void flushErrors($).catch(() => {})
        return r
      } catch (err) {
        noteThrown('classic.FileChanged', err)
        void flushErrors($).catch(() => {})
        throw err
      }
    })
    on('ui.render', { component: 'Pane' }, async ($, e, next) => {
      try {
        const r = await next(e)
        noteFailures('ui.render', next.trace, e)
        return r
      } catch (err) {
        noteThrown('ui.render', err, e)
        throw err
      }
    })
  }

  // Band manager: the band mods hand over their displays (band()); here they are ordered and drawn
  // compact or one line each, or sent to the status line. Upstream mods (Savvy Progress, Next Steps,
  // Replay Theater, Blast Radius) still draw on their own, above.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    openBand(e)
    let rest
    try {
      rest = await next(e)
    } catch (err) {
      if (setting('diagnose') !== 'off') noteThrown('ui.render', err, e)
      throw err
    }
    if (setting('diagnose') !== 'off') noteFailures('ui.render', next.trace, e)
    const parts = takeBand(e).filter(p => toggleOn(p.id))
    if (e.props.hasSurvey) return rest
    const order = bandOrder(setting('bandOrder'))
    parts.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id))
    const status = parts.filter(p => showMode(p.id) === 'status').map(p => p.status)
    try {
      $.ui.status(status.length ? status.join('  ·  ') : undefined)
    } catch {
      // the status line is not reachable from here; the band still draws
    }
    const shown = parts.filter(p => showMode(p.id) === 'band')
    if (shown.length === 0) return rest
    const { Box, Text } = $.ui.resolve(e)
    const isCompact = setting('bandLayout') !== 'lines'
    const own = isCompact ? shown.filter(p => p.urgent) : shown
    const calm = isCompact ? shown.filter(p => !p.urgent) : []
    const withGaps = (actions: unknown[]) => actions.flatMap((a, i) => [<Text key={`gap-${i}`}>{'  '}</Text>, a])
    return (
      <Box flexDirection="column">
        {rest}
        {own.map(p => (
          <Box key={`band-${p.id}`} flexDirection="row" paddingX={1}>
            <Box flexShrink={1}>{p.line as any}</Box>
            {withGaps(p.actions) as any}
          </Box>
        ))}
        {calm.length ? (
          <Box key="band-calm" flexDirection="row" paddingX={1}>
            <Text wrap="truncate-end">
              {calm.flatMap((p, i) => (i === 0 ? [p.short] : [<Text key={`sep-${i}`} dimColor>{'  │  '}</Text>, p.short])) as any}
            </Text>
            {withGaps(calm.flatMap(p => p.actions)) as any}
          </Box>
        ) : null}
      </Box>
    )
  })

  on('session.start', {}, async ($, e, next) => {
    await $.command.register({
      name: 'mod-box',
      description: t('Mod-Box: Mods schalten, Profile, Quellen', 'Mod Box: switch mods, profiles, sources'),
      argumentHint: '[mods|profiles|sources|diag]',
    })
    version = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).then(x => String(JSON.parse(String(x)).version ?? '')).catch(() => '')
    const saved = await $.store.get(STORE_LINKS)
    if (Array.isArray(saved)) await update($, links, () => saved.filter((x): x is string => typeof x === 'string'))
    // A profile set over several reloads continues here.
    void continueProfile($).catch(() => {})
    void adoptNewMods($).catch(() => {})
    void detectOs($).catch(() => {})
    $.clock.every(4000, () => void flushErrors($).catch(() => {}))
    return next(e)
  })

  on('command.run', { command: 'mod-box' }, async ($, e) => {
    const want = String(e.args ?? '').trim().toLowerCase()
    // Diagnosis aid: which /config rows Claude Code hands this plugin.
    if (want === 'keys') {
      const list = await $.config.list().catch((err: unknown) => [{ key: `Fehler: ${String(err)}` }] as any[])
      const opts2 = Object.keys(opts).slice(0, 40).join(', ')
      return { text: `config.list: ${list.length} rows\n${list.map((r: any) => `${r.key} = ${JSON.stringify(r.value)} (${r.kind ?? '?'}, ${r.provider?.plugin ?? '?'}${r.isLocked ? ', gesperrt' : ''})${r.options ? ` [${r.options.join(' | ')}]` : ''}`).join('\n')}\n\noptions: ${opts2 || '(none)'}` }
    }
    const alias: Record<string, Tab> = { mods: 'mods', profiles: 'profiles', profile: 'profiles', sources: 'sources', quellen: 'sources', diagnose: 'diag', diag: 'diag' }
    if (alias[want]) await switchTab($, alias[want])
    await $.ui.open({ id: PANE, title: 'Mod Box', focus: true, closeOnEscape: true })
    const now = await read($, tab)
    if (now === 'sources' && (await read($, sources)) === null) void loadCatalog($, false)
    if ((await read($, envChecks)) === null) void runEnvChecks($).catch(() => {})
    if ((await read($, natives)) === null) void loadNatives($).catch(() => {})
    return { text: t('Mod-Box geöffnet (Esc schließt).', 'Mod Box opened (Esc closes).') }
  })

  on('ui.render', { component: 'Pane', requestId: DIFF_PANE }, async ($, e) => {
    const { Box, Text, Code } = $.ui.resolve(e) as any
    const d = await read($, diff)
    if (!d) return <Text dimColor>{t('Kein Diff.', 'No diff.')}</Text>
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor wrap="wrap">{t(`Was sich im Original von ${d.id} seit unserem Stand geändert hat (${d.from} → ${d.to}). Eigene Anpassungen sind hier nicht enthalten; Übernehmen arbeitet das in sie ein.`, `What changed in the original of ${d.id} since our copy (${d.from} → ${d.to}). Own changes are not shown; Apply merges this into them.`)}</Text>
        {d.text ? (Code ? <Code source={d.text} format="diff" /> : <Text>{d.text}</Text>) : <Text dimColor>{t('(leer)', '(empty)')}</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e) as any
    const { Box, Text, Button } = ui
    const current = await read($, tab)
    const rows = await configRows($)
    const isBusy = await read($, busy)
    const onCount = CATALOG.filter(m => rows.get(m.toggle)?.value === true).length

    const tabs: Array<[Tab, string]> = [
      ['mods', `🧩 ${t('Mods', 'Mods')}`],
      ['profiles', `◐ ${t('Profile', 'Profiles')}`],
      ['sources', `⇩ ${t('Quellen', 'Sources')}`],
      ['diag', `🩺 ${t('Zustand', 'Health')}`],
    ]

    const columns = e.props.bodyColumns ?? 80
    const trusted = await trustedList($)
    let body
    if (current === 'profiles') body = drawProfiles($, ui, rows, columns)
    else if (current === 'sources') body = <Box flexDirection="column">{await drawUpdates($, ui)}{await drawSources($, ui, columns)}</Box>
    else if (current === 'diag') body = <Box flexDirection="column">{await drawUsage($, ui)}{await drawDiagnosis($, ui)}</Box>
    else body = drawMods($, ui, rows, await drawNotes($, ui), await read($, usage), await read($, expanded), columns, { ...(await here($, e.surface)), trusted, fresh: await read($, fresh) }, drawNativeCard($, ui, await read($, natives), await read($, nativeInfo), await read($, expanded), (await $.session.usage().catch(() => null))?.startedAt ?? 0))

    const storedId = await activeProfileId($)
    const matches = (p: (typeof PROFILES)[number]) => profileSet(p, trusted, rows).every(([k, v]) => (rows.get(k)?.value === true) === v)
    const stored = PROFILES.find(p => p.id === storedId)
    // The stored profile while it still fits; else the profile the switches match exactly; else
    // the stored one marked "(changed)".
    const exact = stored && matches(stored) ? stored : PROFILES.find(matches)
    const active = exact ?? stored
    const changed = !exact && !!stored
    const r = await read($, report)
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text>
            <Text bold color="claude">{'🧰 Mod Box'}</Text>
            <Text color="inactive" dimColor>{version ? `  v${version}` : ''}</Text>
          </Text>
          <Text>
            {isBusy ? <Text color="suggestion">{`⏳ ${isBusy}    `}</Text> : null}
            {active ? <Text color="inactive">{`${PROFILE_ICON[active.id] ?? '◎'} ${tx(active.label)}${changed ? t(' (angepasst)', ' (changed)') : ''}    `}</Text> : null}
            <Text color="success" bold>{`${onCount}`}</Text>
            <Text color="inactive">{t(` / ${CATALOG.length} an`, ` / ${CATALOG.length} on`)}</Text>
          </Text>
        </Box>
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} marginTop={1}>
          {tabs.map(([k, text]) => (
            <Button key={`tab-${k}`} label={text} variant={current === k ? 'primary' : 'secondary'} plain={current === k ? undefined : true} onPress={() => void switchTab($, k)} />
          ))}
        </Box>
        {r ? drawReport($, ui, r) : null}
        <Box flexDirection="column" marginTop={1}>
          {body}
        </Box>
        <Text color="inactive" dimColor>
          {t('Klick oder Enter schaltet · ⚙ zeigt Einstellungen · Esc schließt', 'Click or Enter switches · ⚙ shows settings · Esc closes')}
        </Text>
      </Box>
    )
  })
}

// ---------------------------------------------------------------- Mods

/** The row prefix of this plugin in a /config list, found by a field it surely has. */
export function findPrefix(keys: string[], plugin: string, fields: string[]): string | null {
  for (const f of fields) {
    const hit = keys.find(k => k.endsWith('.' + f) && (k.startsWith(plugin + '.') || k.startsWith(plugin + '@')))
    if (hit) return hit.slice(0, hit.length - f.length)
  }
  return null
}

async function configRows($: EngineInterface): Promise<Map<string, ConfigRow>> {
  const list = await $.config.list().catch(() => [] as ConfigRow[])
  const found = findPrefix(list.map(r => r.key), PLUGIN, ['blastRadius', 'language', 'bandLayout', ...CATALOG.map(m => m.toggle)])
  if (found) PREFIX = found
  const own = list.filter(r => r.key.startsWith(PREFIX))
  // Some hosts (the desktop app) list no rows for a plugin's userConfig. Then the window builds them
  // from the catalog and the options it was loaded with, and writes changes to settings.json itself.
  SYNTHETIC = own.length === 0
  return new Map((SYNTHETIC ? syntheticRows() : own).map(r => [r.key.slice(PREFIX.length), r] as const))
}

let SYNTHETIC = false

export function syntheticRows(): ConfigRow[] {
  const provider = { kind: 'plugin', name: PLUGIN } as any
  const field = (f: CatalogField): ConfigRow => {
    const labelled = Object.keys(f.labels?.de ?? f.labels?.en ?? {})
    const choices = labelled.length ? labelled : (f.options ?? [])
    const value = opts[f.key] ?? f.default
    const kind = f.type === 'number' ? 'number' : f.type === 'boolean' || typeof f.default === 'boolean' ? 'boolean' : choices.length ? 'choice' : 'text'
    return { key: PREFIX + f.key, label: tx(f.title), kind, value: value as any, ...(choices.length ? { options: choices } : {}), provider, isLocked: false } as ConfigRow
  }
  const out = SETTINGS.map(field)
  for (const m of CATALOG) {
    out.push({ key: PREFIX + m.toggle, label: tx(m.title), kind: 'boolean', value: (typeof opts[m.toggle] === 'boolean' ? opts[m.toggle] : m.default) as any, provider, isLocked: false } as ConfigRow)
    for (const p of m.params) out.push(field(p))
  }
  return out
}

// The key settings.json keeps this plugin's options under: <name>@inline when loaded from a folder,
// else the installed id already there.
export function configId(keys: string[], root: string): string {
  if (!/[\\/]plugins[\\/]cache[\\/]/.test(root)) return PLUGIN + '@inline'
  return keys.find(k => k.startsWith(PLUGIN + '@') && k !== PLUGIN + '@inline') ?? PLUGIN + '@' + PLUGIN
}

async function writeOptions($: EngineInterface, values: Record<string, unknown>) {
  const path = `${await home($)}/.claude/settings.json`
  try {
    const s = JSON.parse(String(await $.fs.read(path))) as Record<string, any>
    s.pluginConfigs = s.pluginConfigs ?? {}
    const id = configId(Object.keys(s.pluginConfigs), $.plugin.root)
    const entry = (s.pluginConfigs[id] = s.pluginConfigs[id] ?? {})
    entry.options = { ...(entry.options ?? {}), ...values }
    await $.fs.write(path, JSON.stringify(s, null, 2) + '\n')
  } catch (err) {
    $.ui.toast(`${t('Nicht geändert', 'Not changed')}: ${String(err)}`)
    return
  }
  opts = { ...opts, ...values }
  $.ui.toast(Object.entries(values).map(([k, v]) => `${k} = ${String(v)}`).join(', '))
  redraw($)
  // The new options reach the mods with a reload of the box.
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    await $.fs.write(`${$.plugin.root}/hooks/reload.stamp`, String(Date.now())).catch(() => {})
  }
}

// Each group has an icon and an accent from the person's theme, so the window follows their colors.
const GROUP_ICON: Record<string, string> = { guards: '🛡', display: '👁', context: '🧠', watchers: '🔔', imported: '📦' }
const GROUP_ACCENT: Record<string, string> = { guards: 'permission', display: 'suggestion', context: 'planMode', watchers: 'warning', imported: 'merged' }

function toggleExpanded($: EngineInterface, key: string) {
  void update($, expanded, list => (list.includes(key) ? list.filter(x => x !== key) : [...list, key]))
}

function drawParam($: EngineInterface, ui: any, rows: Map<string, ConfigRow>, f: CatalogField, isActive: boolean, indent = 4) {
  const { Box, Text, Button, Select, Input } = ui
  const r = rows.get(f.key)
  if (!r) return null
  const name = tx(f.title).replace(/^[^:]+:\s*/, '')
  const value = r.value == null ? '' : String(r.value)
  const control =
    r.isLocked ? <Text dimColor>{`${label(f, value)} (${t('gesperrt', 'locked')})`}</Text>
    : r.kind === 'choice' && r.options && Select ? (
      <Select key={`sel-${f.key}`} options={r.options.map(o => ({ value: o, label: label(f, o) }))} value={value} onSelect={(v: string) => void set($, r.key, v)} />
    )
    : r.kind === 'boolean' ? (
      <Button key={`b-${f.key}`} plain onPress={() => void set($, r.key, r.value !== true)}>
        <Text color={r.value === true ? 'success' : 'inactive'}>{r.value === true ? '● ' : '○ '}</Text>
        {r.value === true ? t('an', 'on') : t('aus', 'off')}
      </Button>
    )
    : Input ? (
      <Input key={`in-${f.key}`} value={value} placeholder={t('leer = Standard', 'empty = default')} submitLabel={t('Übernehmen', 'Apply')} onSubmit={(v: string) => void set($, r.key, r.kind === 'number' ? Number(v) : v)} />
    )
    : <Text>{value}</Text>
  return (
    <Box key={`p-${f.key}`} flexDirection="row" alignItems="center" paddingLeft={indent}>
      <Box width={22} flexShrink={0}>
        <Text color="inactive" dimColor={!isActive} wrap="truncate-end">{name}</Text>
      </Box>
      {control}
    </Box>
  )
}

/** The first clause of a description: what a closed row shows. */
export function tagline(text: string): string {
  // A parenthesis only ends the tagline when enough comes before it ("Such-Subagenten (Explore) …").
  const stop = text.search(/;\s|\.\s/)
  const paren = text.search(/\s\(/)
  const cut = paren > 40 && (stop < 0 || paren < stop) ? paren : stop
  return (cut > 12 ? text.slice(0, cut) : text).replace(/[.;]\s*$/, '')
}

function card(ui: any, key: string, accent: string, head: unknown, children: unknown) {
  const { Box } = ui
  return (
    <Box key={key} flexDirection="column" borderStyle="round" borderColor={accent} paddingX={1} marginBottom={1}>
      {head as any}
      {children as any}
    </Box>
  )
}

function drawMods($: EngineInterface, ui: any, rows: Map<string, ConfigRow>, notes: unknown, used: Record<string, ModUsage>, open: string[], columns: number, env: Here & { trusted: string[]; fresh: string[] }, nativeCard: unknown = null) {
  const { Box, Text, Button } = ui
  if (rows.size === 0) return <Text dimColor>{t('Keine Einstellungen gefunden. Ist die Mod Box aktiviert?', 'No settings found. Is the Mod Box enabled?')}</Text>

  const groups: string[] = []
  for (const m of CATALOG) if (!groups.includes(m.group)) groups.push(m.group)
  const known = new Set([...SETTINGS.map(s => s.key), ...CATALOG.flatMap(m => [m.toggle, ...m.params.map(p => p.key)])])
  const rest = [...rows.keys()].filter(k => !known.has(k))

  const modRow = (m: (typeof CATALOG)[number]) => {
    const r = rows.get(m.toggle)
    if (!r) return null
    const isOn = r.value === true
    const isOpen = open.includes(m.toggle)
    const hasMore = true
    const issues = compatIssues(m.compat, env)
    const isTrusted = !m.imported || env.trusted.includes(m.toggle)
    const isNew = env.fresh.includes(m.toggle)
    return (
      <Box key={`g-${m.toggle}`} flexDirection="column" marginTop={isOpen ? 1 : 0} marginBottom={isOpen ? 1 : 0}>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" alignItems="center" flexShrink={1}>
            <Button key={`t-${m.toggle}`} plain onPress={() => void switchMod($, m.toggle, r.key, !isOn)}>
              <Text color={isOn ? 'success' : 'inactive'}>{isOn ? '●' : '○'}</Text>
              {' '}
              <Text bold={isOn} color={isOn ? 'text' : 'inactive'}>{tx(m.title)}</Text>
            </Button>
            {m.costs ? <Text color="warning">{' 💰'}</Text> : null}
            {m.imported ? <Text>{isTrusted ? ' 📦' : ' 🔒'}</Text> : null}
            {isNew ? <Text color="claude" bold>{t('  neu', '  new')}</Text> : null}
            {issues.length ? <Text color="warning">{`  ⚠ ${tx(issues[0]!)}`}</Text> : null}
            {m.commands.length ? <Text color="suggestion" dimColor>{`  ${m.commands[0]!.name.split(' ')[0]}`}</Text> : null}
            {used[m.toggle] ? <Text color="warning" dimColor>{`  ${usageText(used[m.toggle]!)}`}</Text> : null}
          </Box>
          {hasMore ? <Button key={`exp-${m.toggle}`} label={isOpen ? '▾' : '⚙'} plain onPress={() => toggleExpanded($, m.toggle)} /> : null}
        </Box>
        <Box paddingLeft={2}>
          <Text color="inactive" dimColor wrap={isOpen ? 'wrap' : 'truncate-end'}>{isOpen ? tx(m.description) : tagline(tx(m.description))}</Text>
        </Box>
        {isOpen ? (
          <Box flexDirection="column" paddingLeft={2}>
            <Text color="inactive" wrap="wrap">{`${t('Läuft auf', 'Runs on')}: ${compatText(m.compat)}`}</Text>
            {issues.map((x, i) => (
              <Text key={`iss-${m.toggle}-${i}`} color="warning" wrap="wrap">{`⚠ ${tx(x)}`}</Text>
            ))}
            {!isTrusted ? (
              <Box flexDirection="row" columnGap={2}>
                <Text color="warning" wrap="wrap">{t('🔒 Fremder Code, noch nicht vertraut: Profile schalten ihn nicht ein.', '🔒 Foreign code, not trusted yet: profiles do not switch it on.')}</Text>
                <Button key={`trust-${m.toggle}`} label={t('Vertrauen', 'Trust')} plain onPress={() => void trustMod($, m.toggle)} />
              </Box>
            ) : null}
          </Box>
        ) : null}
        {isOpen && m.commands.length ? (
          <Box flexDirection="column" paddingLeft={2}>
            {m.commands.map(c => (
              <Text key={`cmd-${m.toggle}-${c.name}`}>
                <Text color="suggestion">{c.name}</Text>
                <Text color="inactive">{`  ${tx(c.text)}`}</Text>
              </Text>
            ))}
          </Box>
        ) : null}
        {isOpen && m.costs ? (
          <Box paddingLeft={2}>
            <Text color="warning" wrap="wrap">{`💰 ${tx(m.costs)}`}</Text>
          </Box>
        ) : null}
        {isOpen ? (
          <Box flexDirection="column">
            {m.params.map(p => drawParam($, ui, rows, p, isOn, 2))}
            {m.toggle === 'secretGuard' || m.imported ? (
              <Box flexDirection="row" paddingLeft={2} gap={2}>
                {m.toggle === 'secretGuard' ? <Button key="sg-allow" label={t('Ausnahmen verwalten', 'Manage exceptions')} plain onPress={() => void $.command.run({ command: 'secret-allow' }).catch(() => $.ui.toast(t('Bitte /secret-allow eingeben.', 'Please type /secret-allow.')))} /> : null}
                {m.imported ? <Button key={`rm-${m.id}`} label={t('Aus der Mod Box entfernen', 'Remove from the Mod Box')} plain onPress={() => void removeMod($, m.id, tx(m.title))} /> : null}
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    )
  }

  const groupCard = (g: string) => {
    const mods = CATALOG.filter(m => m.group === g)
    const on = mods.filter(m => rows.get(m.toggle)?.value === true).length
    const accent = GROUP_ACCENT[g] ?? 'subtle'
    return card(
      ui,
      `grp-${g}`,
      accent,
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color={accent}>{`${GROUP_ICON[g] ?? '•'} ${tx(GROUPS[g]) || g}`}</Text>
        <Text color={on ? 'success' : 'inactive'}>{`${on}/${mods.length}`}</Text>
      </Box>,
      <Box flexDirection="column">{mods.map(modRow)}</Box>,
    )
  }

  // General: language and band layout as selects, the band order in one line with "change".
  const orderOpen = open.includes('bandOrder')
  const general = card(
    ui,
    'card-general',
    'subtle',
    <Text bold color="inactive">{`⚙ ${t('Allgemein', 'General')}`}</Text>,
    <Box flexDirection="column">
      {SETTINGS.filter(s => s.key !== 'bandOrder').map(s => drawParam($, ui, rows, s, true, 0))}
      <Box flexDirection="row" alignItems="center">
        <Box width={22} flexShrink={0}>
          <Text color="inactive">{t('Band-Reihenfolge', 'Band order')}</Text>
        </Box>
        <Button key="ord-toggle" plain onPress={() => toggleExpanded($, 'bandOrder')}>
          {orderOpen
            ? t('fertig', 'done')
            : bandOrder(rows.get('bandOrder')?.value == null ? setting('bandOrder') : String(rows.get('bandOrder')!.value))
                .map(id => shortTitle(id))
                .join(' › ')}
        </Button>
      </Box>
      {orderOpen ? drawOrder($, ui, rows) : null}
    </Box>,
  )
  const extra = rest.length
    ? card(
        ui,
        'card-rest',
        'subtle',
        <Text bold>{t('Weitere', 'More')}</Text>,
        <Box flexDirection="column">{rest.map(k => drawParam($, ui, rows, { key: k, title: { en: rows.get(k)?.label ?? k, de: rows.get(k)?.label ?? k }, description: { en: '', de: '' }, labels: {}, options: null, type: 'string', multiple: false, default: '' }, true, 0))}</Box>,
      )
    : null

  // Wide windows get two columns; the groups are spread so both columns end about level.
  const cards = [...groups.map(g => ({ el: groupCard(g), size: 2 + CATALOG.filter(m => m.group === g).length * 2 + (open.some(k => CATALOG.find(m => m.toggle === k)?.group === g) ? 6 : 0) })), { el: general, size: 6 }]
  if (extra) cards.push({ el: extra, size: 2 + rest.length })
  if (nativeCard) cards.push({ el: nativeCard as any, size: 6 })
  let body
  if (columns >= 110) {
    const cols: Array<{ els: unknown[]; size: number }> = [{ els: [], size: 0 }, { els: [], size: 0 }]
    for (const c of cards) {
      const target = cols[0]!.size <= cols[1]!.size ? cols[0]! : cols[1]!
      target.els.push(c.el)
      target.size += c.size
    }
    body = (
      <Box flexDirection="row" columnGap={2}>
        {cols.map((c, i) => (
          <Box key={`col-${i}`} flexDirection="column" flexGrow={1} flexShrink={1} width="50%">
            {c.els as any}
          </Box>
        ))}
      </Box>
    )
  } else body = <Box flexDirection="column">{cards.map(c => c.el) as any}</Box>

  return (
    <Box flexDirection="column">
      {notes as any}
      {body}
    </Box>
  )
}

// One quiet line above the cards when something wants attention: updates waiting, tokens spent.
async function drawNotes($: EngineInterface, ui: any) {
  const { Box, Text, Button } = ui
  const list = await read($, updates)
  const pending = (list ?? []).filter(u => u.status === 'update').length
  const s = sumBook(await read($, usage))
  if (!pending && !s.calls) return null
  return (
    <Box key="notes" flexDirection="row" columnGap={3} marginBottom={1}>
      {pending ? (
        <Button key="note-upd" plain onPress={() => void switchTab($, 'sources')}>
          <Text color="suggestion">{`⬆ ${pending} ${t(pending === 1 ? 'Update' : 'Updates', pending === 1 ? 'update' : 'updates')}`}</Text>
          <Text dimColor>{t(' unter Quellen', ' under Sources')}</Text>
        </Button>
      ) : null}
      {s.calls ? (
        <Button key="note-usage" plain onPress={() => void switchTab($, 'diag')}>
          <Text color="warning">{`💰 ${usageText(s)}`}</Text>
          <Text dimColor>{t(' in dieser Sitzung', ' this session')}</Text>
        </Button>
      ) : null}
    </Box>
  )
}

function shortTitle(toggle: string): string {
  return (tx(CATALOG.find(m => m.toggle === toggle)?.title) || toggle).replace(/\s*\(.*\)$/, '')
}

// The band order as a list with arrows; writes the comma list into the bandOrder setting.
function drawOrder($: EngineInterface, ui: any, rows: Map<string, ConfigRow>) {
  const { Box, Text, Button } = ui
  const row = rows.get('bandOrder')
  const order = bandOrder(row?.value == null ? setting('bandOrder') : String(row.value))
  const title = (toggle: string) => tx(CATALOG.find(m => m.toggle === toggle)?.title) || toggle
  const move = (i: number, d: number) => {
    const next = [...order]
    const j = i + d
    if (j < 0 || j >= next.length) return
    ;[next[i], next[j]] = [next[j]!, next[i]!]
    void set($, PREFIX + 'bandOrder', next.join(','))
  }
  return (
    <Box key="band-order" flexDirection="column" paddingLeft={2}>
      {order.map((id, i) => (
        <Box key={`ord-${id}`} flexDirection="row" paddingLeft={2}>
          <Button key={`ord-up-${id}`} label="▲" plain onPress={() => move(i, -1)} />
          <Text>{' '}</Text>
          <Button key={`ord-down-${id}`} label="▼" plain onPress={() => move(i, 1)} />
          <Text dimColor={!toggleOn(id) || showMode(id) !== 'band'}>{`  ${i + 1}. ${title(id)}`}</Text>
          {!toggleOn(id) ? <Text dimColor>{`  (${t('aus', 'off')})`}</Text> : showMode(id) !== 'band' ? <Text dimColor>{`  (${showMode(id) === 'status' ? t('Statuszeile', 'status line') : t('ausgeblendet', 'hidden')})`}</Text> : null}
        </Box>
      ))}
    </Box>
  )
}

async function set($: EngineInterface, key: string, value: string | number | boolean) {
  if (SYNTHETIC && key.startsWith(PREFIX)) return writeOptions($, { [key.slice(PREFIX.length)]: value })
  try {
    const r = await $.config.set({ key, value })
    if (r.deny !== undefined) $.ui.toast(`${t('Nicht geändert', 'Not changed')}: ${r.deny}`)
    else $.ui.toast(`${key.startsWith(PREFIX) ? key.slice(PREFIX.length) : key} = ${String(value)}`)
  } catch (err) {
    $.ui.toast(`${t('Nicht geändert', 'Not changed')}: ${String(err)}`)
  }
  redraw($)
}

function redraw($: EngineInterface) {
  try {
    $.ui.invalidate('ui.render')
  } catch {
    // The box is reloading; the new load draws the window anyway.
  }
}

async function switchTab($: EngineInterface, k: Tab) {
  await update($, tab, () => k)
  if (k === 'sources' && (await read($, sources)) === null) void loadCatalog($, false)
  if (k === 'diag' && (await read($, envChecks)) === null) void runEnvChecks($)
}

// ---------------------------------------------------------------- Profiles

const PROFILE_ICON: Record<string, string> = { default: '◎', lean: '🍃', guards: '🛡', all: '✦' }

function drawProfiles($: EngineInterface, ui: any, rows: Map<string, ConfigRow>, columns = 80) {
  // As many cards in a row as fit, never narrower than 26 cells.
  const perRow = Math.max(1, Math.min(PROFILES.length, Math.floor((columns - 2) / 27)))
  const width = Math.max(26, Math.floor((columns - 2 - (perRow - 1)) / perRow))
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column">
      <Text dimColor>{t('Ein Profil setzt alle Schalter auf einmal; Parameter bleiben, wie sie sind.', 'A profile sets all switches at once; parameters stay as they are.')}</Text>
      <Box flexDirection="row" flexWrap="wrap" gap={1} marginTop={1}>
        {PROFILES.map(p => {
          const isActive = p.set.every(([k, v]) => (rows.get(k)?.value === true) === v)
          const on = p.set.filter(([, v]) => v).map(([k]) => shortTitle(k))
          return (
            <Box key={`prof-${p.id}`} flexDirection="column" borderStyle="round" borderColor={isActive ? 'success' : 'subtle'} paddingX={1} width={width}>
              <Box flexDirection="row" justifyContent="space-between">
                <Text bold>{`${PROFILE_ICON[p.id] ?? '•'}  ${tx(p.label)}`}</Text>
                <Text dimColor>{`${on.length}/${p.set.length}`}</Text>
              </Box>
              <Text dimColor wrap="wrap">{on.length ? on.join(' · ') : t('alle aus', 'all off')}</Text>
              <Box marginTop={1}>
                {isActive ? (
                  <Text color="success">{`● ${t('aktiv', 'active')}`}</Text>
                ) : (
                  <Button key={`prof-b-${p.id}`} label={t('Anwenden', 'Apply')} variant="primary" onPress={() => void applyProfile($, p.id)} />
                )}
              </Box>
            </Box>
          )
        })}
      </Box>
    </Box>
  )
}

async function applyProfile($: EngineInterface, id: string) {
  const p = PROFILES.find(x => x.id === id)
  if (!p) return
  await $.store.set(STORE_ACTIVE, p.id)
  if ((await read($, natives))?.some(n => n.managed && n.trusted)) await nativeRun($, ['profile', p.id], t('Profil für native Plugins …', 'Profile for native plugins …'))
  const values = profileSet(p, await trustedList($), await configRows($))
  if (SYNTHETIC || (await configRows($), SYNTHETIC)) return writeOptions($, Object.fromEntries(values))
  await $.store.set(STORE_PENDING, values.map(([k, v]) => [k, v]))
  $.ui.toast(t(`Profil „${tx(p.label)}“ wird gesetzt …`, `Applying profile "${tx(p.label)}" …`))
  await continueProfile($)
}

// Every change reloads the box; what is still pending sits in the store and is continued after the
// reload (session.start) until nothing differs any more.
async function continueProfile($: EngineInterface) {
  for (let guard = 0; guard < 50; guard++) {
    const pending = await $.store.get(STORE_PENDING)
    if (!Array.isArray(pending) || pending.length === 0) return
    const rows = await configRows($)
    const idx = pending.findIndex(([k, v]) => rows.has(String(k)) && rows.get(String(k))!.value !== v)
    if (idx < 0) {
      await $.store.delete(STORE_PENDING)
      $.ui.toast(t('Profil gesetzt.', 'Profile applied.'))
      redraw($)
      return
    }
    const [k, v] = pending[idx] as [string, boolean]
    await $.store.set(STORE_PENDING, pending.filter((_, i) => i !== idx))
    const r = await $.config.set({ key: PREFIX + k, value: v }).catch(() => null)
    if (r && r.deny !== undefined) $.ui.toast(`${k}: ${r.deny}`)
  }
}

// ---------------------------------------------------------------- Profiles for new mods, trust, compatibility

/** A profile's switches, with imported mods nobody trusted yet kept off. */
// What a profile sets: its rule, but foreign mods only once trusted, and no mod while one of its
// required options is still empty (it would start without what it needs).
function profileSet(p: (typeof PROFILES)[number], trusted: string[], rows?: Map<string, { value: unknown }>): Array<[string, boolean]> {
  const unset = (k: string) => {
    const v = rows?.get(k)?.value
    return rows !== undefined && (v === undefined || v === null || v === '')
  }
  return p.set.map(([k, v]) => {
    const m = CATALOG.find(x => x.toggle === k)
    return [k, v && (!m?.imported || trusted.includes(k)) && !(m?.needs ?? []).some(unset)]
  })
}

/** The profile applied last; "default" until one is applied in the window. */
async function activeProfileId($: EngineInterface): Promise<string> {
  const v = await $.store.get(STORE_ACTIVE).catch(() => null)
  return typeof v === 'string' ? v : 'default'
}

async function trustedList($: EngineInterface): Promise<string[]> {
  const v = await $.store.get(STORE_TRUSTED).catch(() => null)
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

async function trustMod($: EngineInterface, toggle: string) {
  const list = await trustedList($)
  if (!list.includes(toggle)) await $.store.set(STORE_TRUSTED, [...list, toggle])
  // From now on the active profile decides about it, as about every other mod.
  const activeId = await activeProfileId($)
  const p = PROFILES.find(x => x.id === activeId)
  const want = p?.set.find(([k]) => k === toggle)?.[1]
  if (want !== undefined) await setMany($, { [toggle]: want })
  else redraw($)
}

/** Switching an imported mod on by hand counts as trusting it. */
async function switchMod($: EngineInterface, toggle: string, key: string, value: boolean) {
  const m = CATALOG.find(x => x.toggle === toggle)
  if (value && m?.needs.length) {
    const rows = await configRows($)
    const unset = m.needs.filter(k => {
      const v = rows.get(k)?.value
      return v === undefined || v === null || v === ''
    })
    if (unset.length) {
      $.ui.toast(t(`Erst setzen: ${unset.join(', ')} (⚙ beim Mod).`, `Set these first: ${unset.join(', ')} (⚙ at the mod).`))
      return
    }
  }
  if (value && CATALOG.find(m => m.toggle === toggle)?.imported) {
    const list = await trustedList($)
    if (!list.includes(toggle)) await $.store.set(STORE_TRUSTED, [...list, toggle])
  }
  await set($, key, value)
}

/** Several switches at once: one write where the host lists no rows, else the reload chain. */
async function setMany($: EngineInterface, values: Record<string, boolean>) {
  if (SYNTHETIC || (await configRows($), SYNTHETIC)) return writeOptions($, values)
  await $.store.set(STORE_PENDING, Object.entries(values))
  await continueProfile($)
}

/**
 * Mods that are new since the last session take the switch the active profile gives them, so a
 * profile keeps meaning what it says when the box grows. Imported mods wait for trust.
 */
async function adoptNewMods($: EngineInterface) {
  const all = CATALOG.map(m => m.toggle)
  const seen = await $.store.get(STORE_SEEN).catch(() => null)
  await $.store.set(STORE_SEEN, all)
  if (!Array.isArray(seen)) return
  const added = all.filter(x => !seen.includes(x))
  if (!added.length) return
  await update($, fresh, () => added)
  const activeId = await activeProfileId($)
  const p = PROFILES.find(x => x.id === activeId)
  if (!p) return
  const rows = await configRows($)
  const want = profileSet(p, await trustedList($), rows).filter(([k, v]) => added.includes(k) && (rows.get(k)?.value === true) !== v)
  if (!want.length) return
  $.ui.toast(t(`Neu in der Mod Box: ${added.length}. Profil „${tx(p.label)}“ angewandt.`, `New in the Mod Box: ${added.length}. Profile "${tx(p.label)}" applied.`))
  await setMany($, Object.fromEntries(want))
}

type Here = { os: string; surface: string; missing: string[] }

// The operating system, found once per load: Windows from its OS variable, the rest from uname.
// Unknown until then; an unknown system raises no OS warning rather than a wrong one.
let detectedOs: string | null = null

/** windows | mac | linux from `uname -s` output, or null when it says something else. */
export function osFromUname(out: string): string | null {
  const name = out.trim().toLowerCase()
  if (name.startsWith('darwin')) return 'mac'
  if (name.startsWith('linux')) return 'linux'
  if (/^(mingw|msys|cygwin|windows)/.test(name)) return 'windows'
  return null
}

async function detectOs($: EngineInterface) {
  if (detectedOs) return
  if ((await $.env.get('OS').catch(() => undefined)) === 'Windows_NT') {
    detectedOs = 'windows'
    return
  }
  const r = await $.process.run(['uname', '-s'], { timeoutMs: 5000 }).catch(() => null)
  detectedOs = r && r.exitCode === 0 ? osFromUname(r.stdout) : null
}

async function here($: EngineInterface, surface: string): Promise<Here> {
  const isWin = detectedOs === 'windows' || (await $.env.get('OS').catch(() => undefined)) === 'Windows_NT'
  const os = isWin ? 'windows' : (detectedOs ?? '')
  const env = (await read($, envChecks)) ?? []
  const id: Record<string, string> = { node: 'node', git: 'git', gh: 'gh', sign: 'signScript', bash: 'bash' }
  const missing = env.filter(c => c.ok === false && id[c.id]).map(c => id[c.id]!)
  if (os && !isWin) missing.push('powershell')
  return { os, surface, missing }
}

const SURFACE_NAME: Record<string, [string, string]> = { terminal: ['Terminal', 'terminal'], desktop: ['Desktop-App', 'desktop app'], vscode: ['VS Code', 'VS Code'], mobile: ['Mobil', 'mobile'] }
const OS_NAME: Record<string, string> = { windows: 'Windows', mac: 'macOS', linux: 'Linux' }
const NEED_NAME: Record<string, [string, string]> = { git: ['git', 'git'], gh: ['gh (angemeldet)', 'gh (signed in)'], node: ['Node.js', 'Node.js'], bash: ['Git-Bash', 'Git Bash'], powershell: ['PowerShell', 'PowerShell'], signScript: ['ein Signierskript', 'a signing script'] }
const name2 = (pair: [string, string] | undefined, fallback: string) => (pair ? t(pair[0], pair[1]) : fallback)

export function compatText(c: CatalogMod['compat']): string {
  const surfaces = c.surfaces.length === 4 ? t('überall', 'everywhere') : c.surfaces.map(x => name2(SURFACE_NAME[x], x)).join(', ')
  const os = c.os.length === 3 ? '' : ' · ' + c.os.map(x => OS_NAME[x] ?? x).join(', ')
  const needs = c.needs.length ? ' · ' + t('braucht', 'needs') + ' ' + c.needs.map(x => name2(NEED_NAME[x], x)).join(', ') : ''
  return surfaces + os + needs
}

/** Why a mod would not (fully) run here, each reason as German and English text. */
export function compatIssues(c: CatalogMod['compat'], h: Here): Array<{ de: string; en: string }> {
  const out: Array<{ de: string; en: string }> = []
  const list = (xs: string[], names: Record<string, [string, string]>, i: 0 | 1) => xs.map(x => names[x]?.[i] ?? x).join(', ')
  if (h.surface && !c.surfaces.includes(h.surface)) out.push({ de: 'nur ' + list(c.surfaces, SURFACE_NAME, 0), en: list(c.surfaces, SURFACE_NAME, 1) + ' only' })
  const osNames = c.os.map(x => OS_NAME[x] ?? x).join(', ')
  if (h.os && !c.os.includes(h.os)) out.push({ de: 'nur ' + osNames, en: osNames + ' only' })
  const lacking = c.needs.filter(x => h.missing.includes(x))
  if (lacking.length) out.push({ de: 'braucht ' + list(lacking, NEED_NAME, 0), en: 'needs ' + list(lacking, NEED_NAME, 1) })
  return out
}

// ---------------------------------------------------------------- Native plugins

// Plugins the box does not carry inside itself: installed as plugins of their own and driven
// through `claude plugin ...` (tools/native.mjs). Switching, options and updates take effect when
// Claude Code loads plugins again (a new session; in the desktop app a restart).

async function loadNatives($: EngineInterface) {
  const res = await box($, ['native', 'list'])
  if (!res.ok) {
    await update($, natives, () => [])
    await update($, report, () => ({ ok: false, title: t('Installierte Plugins lesen', 'Reading installed plugins'), error: String(res.error ?? '?'), notes: [] }))
    return
  }
  const list: NativePlugin[] = ((res.plugins ?? []) as any[]).map(p => ({
    id: String(p.id),
    version: String(p.version ?? ''),
    enabled: p.enabled === true,
    managed: p.managed === true,
    trusted: p.trusted === true,
    group: String(p.group ?? 'native'),
    tokens: String(p.tokens ?? 'none'),
    hasUserConfig: p.hasUserConfig === true,
    errors: Array.isArray(p.errors) ? p.errors.map(String) : [],
    changedAt: p.changedAt ? String(p.changedAt) : null,
    missing: p.missing === true,
  }))
  await update($, natives, () => list)
}

/** Runs `box.mjs native <args>`; a failure becomes the report, the list is read again afterwards. */
async function nativeRun($: EngineInterface, args: string[], busyText: string, stdin?: string): Promise<any> {
  if (await read($, busy)) return null
  await update($, busy, () => busyText)
  let res: any = null
  try {
    res = await box($, ['native', ...args], 600_000, stdin)
    if (!res.ok) await update($, report, () => ({ ok: false, title: busyText.replace(/\s*…$/, ''), error: String(res.error ?? res.message ?? '?').slice(0, 1500), notes: [] }))
    else if (res.restart) $.ui.toast(t('Wirkt, sobald Claude Code die Plugins neu lädt (neue Sitzung; in der Desktop-App: neu starten).', 'Takes effect when Claude Code loads plugins again (a new session; in the desktop app: restart).'), { timeoutMs: 8000 })
  } finally {
    await update($, busy, () => null)
  }
  await loadNatives($)
  return res
}

async function nativeInfoOf($: EngineInterface, id: string) {
  const [d, o] = await Promise.all([box($, ['native', 'details', id]), box($, ['native', 'options', id])])
  const info: NativeInfo = {
    components: d.ok ? (d.components as NativeInfo['components']) : null,
    alwaysOn: d.ok ? (d.tokens?.alwaysOn ?? null) : null,
    fields: o.ok ? ((o.fields ?? []) as NativeField[]) : null,
    ...(d.ok ? {} : { error: String(d.error ?? '') }),
  }
  await update($, nativeInfo, m => ({ ...m, [id]: info }))
}

async function toggleNative($: EngineInterface, id: string) {
  const key = 'n:' + id
  const isOpening = !(await read($, expanded)).includes(key)
  toggleExpanded($, key)
  if (isOpening && !(await read($, nativeInfo))[id]) await nativeInfoOf($, id)
}

async function switchNative($: EngineInterface, p: NativePlugin) {
  if (!p.enabled && p.managed && !p.trusted) {
    $.ui.toast(t('Erst vertrauen: das ist fremder Code (⚙ → Vertrauen).', 'Trust it first: it is foreign code (⚙ → Trust).'))
    return
  }
  await nativeRun($, [p.enabled ? 'disable' : 'enable', p.id], p.enabled ? t(`${p.id} wird ausgeschaltet …`, `Switching ${p.id} off …`) : t(`${p.id} wird eingeschaltet …`, `Switching ${p.id} on …`))
}

async function trustNative($: EngineInterface, id: string, trusted: boolean) {
  const res = await nativeRun($, [trusted ? 'trust' : 'untrust', id], t('Vertrauen wird gesetzt …', 'Setting trust …'))
  // From now on the active profile decides about it, as about every other mod.
  if (res?.ok && trusted) await nativeRun($, ['profile', await activeProfileId($)], t('Profil wird angewandt …', 'Applying the profile …'))
}

async function setNativeOption($: EngineInterface, id: string, key: string, value: string) {
  const res = await nativeRun($, ['set', id], t('Option wird gespeichert …', 'Saving the option …'), JSON.stringify({ [key]: value }))
  if (res?.ok) {
    $.ui.toast(t(`${key} gespeichert. Wirkt nach dem Neuladen der Plugins.`, `${key} saved. Takes effect when plugins load again.`))
    await nativeInfoOf($, id)
  }
}

async function updateNative($: EngineInterface, id: string) {
  const res = await nativeRun($, ['update', id], t(`${id} wird aktualisiert …`, `Updating ${id} …`))
  if (!res?.ok) return
  const text = res.diffFile ? String(await $.fs.read(String(res.diffFile)).catch(() => '')) : ''
  await update($, report, () => ({
    ok: true,
    title: t(`${id} aktualisiert`, `${id} updated`),
    notes: [
      `${res.from || '?'} → ${res.to || '?'}`,
      t(`neu: ${res.added?.length ?? 0} · entfernt: ${res.removed?.length ?? 0} · geändert: ${res.changed?.length ?? 0}`, `added: ${res.added?.length ?? 0} · removed: ${res.removed?.length ?? 0} · changed: ${res.changed?.length ?? 0}`),
    ],
  }))
  if (text) {
    await update($, diff, () => ({ id, from: String(res.from ?? ''), to: String(res.to ?? ''), text }))
    await $.ui.open({ id: DIFF_PANE, title: `Diff ${id}` }).catch(() => {})
  }
}

async function installNative($: EngineInterface, src: Source, p: SourcePlugin) {
  const args = src.kind === 'claude' && p.nativeId ? ['install', p.nativeId] : p.dir ? ['install', p.name, '--dir', p.dir] : ['install', p.name, '--source', src.link]
  const res = await nativeRun($, args, t(`${p.name} wird installiert …`, `Installing ${p.name} …`))
  if (res?.confirm) {
    await update($, report, () => ({ ok: false, title: t(`${p.name}: Befehl bestätigen`, `${p.name}: confirm a command`), error: t(`Der Marketplace will bei der Installation diesen Befehl ausführen: ${res.confirm.command}\nDie Box bestätigt das nicht selbst. Wenn du ihm traust: claude plugin install ${p.nativeId ?? p.name} --accept-command ${res.confirm.sha256}`, `The marketplace wants to run this command on install: ${res.confirm.command}\nThe box does not confirm it itself. If you trust it: claude plugin install ${p.nativeId ?? p.name} --accept-command ${res.confirm.sha256}`), notes: [] }))
    return
  }
  if (res?.ok) await update($, report, () => ({ ok: true, title: t(`${p.name} installiert`, `${p.name} installed`), notes: [t('Nativ installiert und ausgeschaltet, bis du ihm vertraust (Mods → Nativ verwaltet).', 'Installed natively and switched off until you trust it (Mods → Managed natively).')] }))
}

const PART_LABEL: Record<string, [string, string]> = { Skills: ['Skills', 'skills'], Agents: ['Agents', 'agents'], Hooks: ['Hooks', 'hooks'], 'MCP servers': ['MCP-Server', 'MCP servers'], 'LSP servers': ['LSP-Server', 'LSP servers'] }

function drawNativeCard($: EngineInterface, ui: any, list: NativePlugin[] | null, info: Record<string, NativeInfo>, open: string[], startedAt: number) {
  const { Box, Text, Button, Select, Input } = ui
  const managed = (list ?? []).filter(p => p.managed)
  const others = (list ?? []).filter(p => !p.managed)
  const on = managed.filter(p => p.enabled).length
  const row = (p: NativePlugin) => {
    const isOpen = open.includes('n:' + p.id)
    const [name, market] = p.id.split('@')
    const pending = !!p.changedAt && Date.parse(p.changedAt) > startedAt
    const inf = info[p.id]
    return (
      <Box key={`nat-${p.id}`} flexDirection="column" marginTop={isOpen ? 1 : 0} marginBottom={isOpen ? 1 : 0}>
        <Box flexDirection="row" alignItems="center" justifyContent="space-between">
          <Box flexDirection="row" alignItems="center" flexShrink={1}>
            <Button key={`nt-${p.id}`} plain onPress={() => void switchNative($, p)}>
              <Text color={p.enabled ? 'success' : 'inactive'}>{p.enabled ? '●' : '○'}</Text>
              {' '}
              <Text bold={p.enabled} color={p.enabled ? 'text' : 'inactive'}>{name}</Text>
            </Button>
            <Text color="inactive">{`@${market}${p.version ? ' ' + p.version : ''}`}</Text>
            {!p.trusted ? <Text>{' 🔒'}</Text> : null}
            {p.tokens !== 'none' ? <Text color="warning">{' 💰'}</Text> : null}
            {pending ? <Text color="suggestion">{t('  ↻ nach Neustart', '  ↻ after restart')}</Text> : null}
            {p.errors.length ? <Text color="error">{`  ⚠ ${p.errors[0]}`}</Text> : null}
          </Box>
          <Button key={`nx-${p.id}`} label={isOpen ? '▾' : '⚙'} plain onPress={() => void toggleNative($, p.id)} />
        </Box>
        {isOpen ? (
          <Box flexDirection="column" paddingLeft={2}>
            {!inf ? <Text color="inactive">{t('Lese Details …', 'Reading details …')}</Text> : null}
            {inf?.error ? <Text color="error" wrap="wrap">{inf.error}</Text> : null}
            {inf?.components
              ? Object.entries(inf.components)
                  .filter(([, c]) => c.count > 0)
                  .map(([k, c]) => (
                    <Text key={`np-${p.id}-${k}`} color="inactive" wrap="wrap">{`${PART_LABEL[k] ? t(PART_LABEL[k]![0], PART_LABEL[k]![1]) : k} (${c.count}): ${c.names.join(', ')}`}</Text>
                  ))
              : null}
            {inf?.alwaysOn ? <Text color="warning">{t(`💰 immer im Kontext: ~${inf.alwaysOn} Token je Sitzung`, `💰 always in context: ~${inf.alwaysOn} tokens per session`)}</Text> : null}
            {(inf?.fields ?? []).map(f => (
              <Box key={`nf-${p.id}-${f.key}`} flexDirection="row" alignItems="center">
                <Box width={22} flexShrink={0}>
                  <Text color="inactive" wrap="truncate-end">{f.title}</Text>
                </Box>
                {f.sensitive ? (
                  <Box flexDirection="row" columnGap={2}>
                    <Text color={f.set ? 'success' : 'warning'}>{f.set ? t('🔑 gesetzt', '🔑 set') : t('🔑 nicht gesetzt', '🔑 not set')}</Text>
                    <Button key={`ns-${p.id}-${f.key}`} label={t('Sicher setzen: /plugin configure kopieren', 'Set securely: copy /plugin configure')} plain onPress={(press: { surface?: string }) => void $.ui.copy({ text: `/plugin configure ${p.id}`, surface: press.surface as any })} />
                  </Box>
                ) : f.options && Select ? (
                  <Select key={`nsel-${p.id}-${f.key}`} options={f.options.map(o => ({ value: o, label: o }))} value={String(f.value ?? f.default ?? '')} onSelect={(v: string) => void setNativeOption($, p.id, f.key, v)} />
                ) : f.type === 'boolean' ? (
                  <Button key={`nb-${p.id}-${f.key}`} plain label={String(f.value) === 'true' ? t('an', 'on') : t('aus', 'off')} onPress={() => void setNativeOption($, p.id, f.key, String(f.value) === 'true' ? 'false' : 'true')} />
                ) : Input ? (
                  <Input key={`nin-${p.id}-${f.key}`} value={f.value == null ? '' : String(f.value)} placeholder={f.required ? t('Pflicht', 'required') : t('leer = Standard', 'empty = default')} submitLabel={t('Übernehmen', 'Apply')} onSubmit={(v: string) => void setNativeOption($, p.id, f.key, v)} />
                ) : null}
              </Box>
            ))}
            <Box flexDirection="row" columnGap={2} marginTop={1}>
              <Button key={`ntr-${p.id}`} label={p.trusted ? t('Vertrauen entziehen', 'Untrust') : t('Vertrauen', 'Trust')} plain onPress={() => void trustNative($, p.id, !p.trusted)} />
              <Button key={`nup-${p.id}`} label={t('Aktualisieren', 'Update')} plain onPress={() => void updateNative($, p.id)} />
              <Button key={`nrm-${p.id}`} label={t('Deinstallieren', 'Uninstall')} plain onPress={() => void nativeRun($, ['uninstall', p.id], t(`${p.id} wird deinstalliert …`, `Uninstalling ${p.id} …`))} />
              <Button key={`nrp-${p.id}`} label={t('… samt nicht mehr gebrauchter Abhängigkeiten', '… with dependencies nobody needs')} plain onPress={() => void nativeRun($, ['uninstall', p.id, '--prune'], t(`${p.id} wird deinstalliert …`, `Uninstalling ${p.id} …`))} />
            </Box>
            {!p.trusted ? <Text color="warning" wrap="wrap">{t('🔒 Fremder Code, noch nicht vertraut: bleibt aus, Profile schalten ihn nicht ein. Vertrauen ist eine bewusste Entscheidung, keine Sandbox.', '🔒 Foreign code, not trusted yet: stays off, profiles do not switch it on. Trust is a deliberate decision, not a sandbox.')}</Text> : null}
          </Box>
        ) : null}
      </Box>
    )
  }
  return (
    <Box key="card-native" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="claude">{t('🔌 Nativ verwaltet', '🔌 Managed natively')}</Text>
        <Text color={on ? 'success' : 'inactive'}>{list ? `${on}/${managed.length}` : '…'}</Text>
      </Box>
      <Text color="inactive" wrap="wrap">{t('Eigenständig installierte Plugins (Skills, Agents, MCP/LSP, Settings-Hooks …). Die Box schaltet, konfiguriert, aktualisiert und entfernt sie über Claude Code.', 'Plugins installed as themselves (skills, agents, MCP/LSP, settings hooks …). The box switches, configures, updates and removes them through Claude Code.')}</Text>
      {list === null ? <Text color="inactive">{t('Lese installierte Plugins …', 'Reading installed plugins …')}</Text> : null}
      {list && managed.length === 0 ? <Text color="inactive">{t('Noch keine. Unter Quellen „Nativ installieren“, oder unten ein installiertes Plugin übernehmen.', 'None yet. Sources → "Install natively", or take over an installed plugin below.')}</Text> : null}
      {managed.map(row)}
      {others.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="inactive">{t('Weitere installierte Plugins (nicht von der Box verwaltet):', 'Other installed plugins (not managed by the box):')}</Text>
          {others.map(p => (
            <Box key={`no-${p.id}`} flexDirection="row" columnGap={2}>
              <Text color={p.enabled ? 'text' : 'inactive'}>{`${p.enabled ? '●' : '○'} ${p.id}`}</Text>
              <Button key={`nad-${p.id}`} label={t('Verwalten', 'Manage')} plain onPress={() => void nativeRun($, ['adopt', p.id], t('Wird übernommen …', 'Taking it over …'))} />
            </Box>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

// ---------------------------------------------------------------- Sources

async function box($: EngineInterface, args: string[], timeoutMs = 300_000, stdin?: string): Promise<any> {
  const script = `${$.plugin.root}/tools/box.mjs`
  const r = await $.process.run(['node', script, ...args, '--lang', lang], { timeoutMs, cwd: $.plugin.root, ...(stdin !== undefined ? { stdin } : {}) }).catch((err: unknown) => ({
    exitCode: -1,
    stdout: '',
    stderr: String(err),
  }))
  const line = r.stdout.trim().split('\n').pop() ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return { ok: false, error: (r.stderr || r.stdout || t('keine Antwort von node', 'no answer from node')).trim().split('\n').slice(-3).join(' ') }
  }
}

async function loadCatalog($: EngineInterface, refresh: boolean) {
  if (await read($, busy)) return
  await update($, busy, () => (refresh ? t('Quellen werden aktualisiert …', 'Updating sources …') : t('Quellen werden gelesen …', 'Reading sources …')))
  try {
    const l = await read($, links)
    const res = await box($, ['catalog', ...l.flatMap(u => ['--url', u]), ...(refresh ? ['--refresh'] : [])])
    if (!res.ok) {
      await update($, report, () => ({ ok: false, title: t('Quellen lesen', 'Reading sources'), error: res.error ?? '?', notes: [] }))
      return
    }
    const list: Source[] = ((res.sources ?? []) as any[]).map(s => ({
      kind: s.kind,
      name: String(s.name ?? s.link),
      link: String(s.link ?? ''),
      dir: s.dir ?? null,
      ...(s.error ? { error: String(s.error) } : {}),
      plugins: (s.plugins ?? []).map((p: any) => ({
        name: String(p.name),
        description: String(p.description ?? '').slice(0, 200),
        isMod: p.isMod === true ? true : p.isMod === false ? false : null,
        extras: Array.isArray(p.extras) ? p.extras : [],
        imported: p.imported ?? null,
        verdict: p.verdict ?? null,
        reasons: Array.isArray(p.reasons) ? p.reasons.map(String) : [],
        parts: partsOf(p.components),
        nativeId: p.nativeId ?? null,
        dir: p.dir ?? null,
      })),
    }))
    await update($, sources, () => list)
    await update($, loadedAt, () => Date.now())
  } finally {
    await update($, busy, () => null)
  }
}

async function addLink($: EngineInterface, raw: string) {
  const link = raw.trim()
  if (!link) return
  if (!/^([\w.-]+\/[\w.-]+|https?:\/\/\S+|git@\S+|ssh:\/\/\S+|[a-zA-Z]:[\\/]\S*|\/\S+)$/.test(link)) {
    $.ui.toast(t('Das sieht nicht nach einem Git-Link aus (owner/repo, https://…, git@…).', 'That does not look like a git link (owner/repo, https://…, git@…).'))
    return
  }
  const next = await update($, links, l => (l.includes(link) ? l : [...l, link]))
  await $.store.set(STORE_LINKS, next)
  await update($, open, o => (o.includes(link) ? o : [...o, link]))
  await loadCatalog($, false)
}

async function removeLink($: EngineInterface, link: string) {
  const next = await update($, links, l => l.filter(x => x !== link))
  await $.store.set(STORE_LINKS, next)
  await update($, sources, q => (q ? q.filter(s => !(s.kind === 'link' && s.link === link)) : q))
}

async function importFrom($: EngineInterface, src: Source, plugin: string) {
  if (await read($, busy)) return
  await update($, busy, () => t(`${plugin} wird übernommen und geprüft …`, `Importing and checking ${plugin} …`))
  try {
    const strategy = ['--strategy', setting('importStrategy') || 'auto']
    const args = src.kind === 'link' ? ['import', '--url', src.link, '--plugin', plugin, ...strategy] : ['import', '--dir', src.dir ?? '', '--plugin', plugin, ...strategy]
    const res = await box($, args, 600_000)
    await update($, report, () => ({
      ok: res.ok === true,
      title: t(`${plugin} übernehmen`, `Import ${plugin}`),
      ...(res.id ? { id: String(res.id) } : {}),
      ...(res.error ? { error: String(res.error).slice(0, 1500) } : {}),
      notes: [...(Array.isArray(res.reasons) ? res.reasons.slice(1).map(String) : []), ...(res.native ? [String(res.native)] : []), ...(Array.isArray(res.notes) ? res.notes.map(String) : [])],
    }))
    if (res.ok) await afterChange($, t(`${plugin} ist in der Mod-Box (Schalter „${res.toggle}“, zunächst aus).`, `${plugin} is in the Mod Box (switch "${res.toggle}", off for now).`))
  } finally {
    await update($, busy, () => null)
  }
}

async function removeMod($: EngineInterface, id: string, title: string) {
  if (await read($, busy)) return
  await update($, busy, () => t(`${title} wird entfernt …`, `Removing ${title} …`))
  try {
    const res = await box($, ['remove', id], 120_000)
    await update($, report, () => ({ ok: res.ok === true, title: t(`${title} entfernen`, `Remove ${title}`), ...(res.error ? { error: String(res.error) } : {}), notes: [] }))
    if (res.ok) await afterChange($, t(`${title} ist aus der Mod-Box entfernt.`, `${title} was removed from the Mod Box.`))
  } finally {
    await update($, busy, () => null)
  }
}

// After the box was rebuilt: refresh the source list and let Claude Code reload.
async function afterChange($: EngineInterface, message: string) {
  $.ui.toast(message)
  await update($, sources, () => null)
  try {
    await $.command.run({ command: 'reload-plugins' })
  } catch {
    $.ui.toast(t('Bitte /reload-plugins eingeben, damit die Änderung greift.', 'Please run /reload-plugins for the change to take effect.'))
  }
}

function drawReport($: EngineInterface, ui: any, r: ImportReport) {
  const { Box, Text, Button } = ui
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Box flexDirection="row">
        <Text color={r.ok ? 'success' : 'error'} bold>{`${r.ok ? '✔' : '✘'} ${r.title}`}</Text>
        <Text>{'  '}</Text>
        <Button key="rep-close" label="×" plain onPress={() => void update($, report, () => null)} />
      </Box>
      {r.error ? <Text wrap="wrap" color="error">{r.error}</Text> : null}
      {r.notes.map((n, i) => (
        <Text key={`rep-n-${i}`} wrap="wrap" dimColor>{`• ${n}`}</Text>
      ))}
      {r.ok && !r.error && r.id ? <Text dimColor>{t('Neu laden: /reload-plugins (wird versucht). Danach im Reiter Mods einschalten.', 'Reload: /reload-plugins (attempted). Then switch it on in the Mods tab.')}</Text> : null}
    </Box>
  )
}

async function drawSources($: EngineInterface, ui: any, columns: number) {
  const { Box, Text, Button, Input } = ui
  const list = await read($, sources)
  const f = (await read($, filter)).toLowerCase()
  const opened = await read($, open)
  const isBusy = await read($, busy)
  const at = await read($, loadedAt)
  const nativeIds = ((await read($, natives)) ?? []).map(n => n.id)

  const header = (
    <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="subtle" paddingX={1}>
      <Text bold>{`⇩  ${t('Quellen und Marketplaces', 'Sources and marketplaces')}`}</Text>
      <Text dimColor wrap="wrap">
        {t(
          'Verbundene Claude-Marketplaces erscheinen von selbst. Eigene Quellen: ein Git-Link zu einem Marketplace, einem Plugin-Repo oder einer Mod-Sammlung. Übernommene Mods werden für die Mod-Box umgeschrieben (State, Matcher, Pfade), geprüft und starten ausgeschaltet.',
          'Connected Claude marketplaces show up by themselves. Own sources: a git link to a marketplace, a plugin repo or a mod collection. Imported mods are rewritten for the Mod Box (state, matchers, paths), validated, and start switched off.',
        )}
      </Text>
      <Text color="warning" wrap="wrap">
        {t(
          'Fremder Code läuft danach in deiner Sitzung (er darf Befehle ausführen). Nur Quellen übernehmen, denen du traust.',
          'Imported code then runs in your session (it may run commands). Only import from sources you trust.',
        )}
      </Text>
      {Input ? (
        <Box flexDirection="row" marginTop={1}>
          <Input key="link-new" label={t('Git-Link: ', 'Git link: ')} placeholder={t('owner/repo oder https://github.com/…', 'owner/repo or https://github.com/…')} submitLabel={t('Hinzufügen', 'Add')} onSubmit={(v: string) => void addLink($, v)} />
        </Box>
      ) : null}
      <Box flexDirection="row" marginTop={1}>
        {Input ? <Input key="filter" label={t('Filter: ', 'Filter: ')} value={f} placeholder={t('Name oder Beschreibung', 'name or description')} submitLabel={t('Filtern', 'Filter')} onSubmit={(v: string) => void update($, filter, () => v.trim())} /> : null}
        <Text>{'  '}</Text>
        <Button key="sources-refresh" label={isBusy ? '…' : t('Aktualisieren', 'Refresh')} plain onPress={() => void loadCatalog($, true)} />
        {at ? <Text dimColor>{`  ${t('Stand', 'as of')} ${new Date(at).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' })}`}</Text> : null}
      </Box>
    </Box>
  )
  if (list === null) {
    return (
      <Box flexDirection="column">
        {header}
        <Text dimColor>{isBusy ? t('Lese Quellen …', 'Reading sources …') : t('Noch nicht gelesen.', 'Not read yet.')}</Text>
        {!isBusy ? <Button key="sources-load" label={t('Quellen lesen', 'Read sources')} onPress={() => void loadCatalog($, false)} /> : null}
      </Box>
    )
  }

  const width = Math.max(30, columns - 40)
  const match = (p: { name: string; description: string }) => !f || p.name.toLowerCase().includes(f) || p.description.toLowerCase().includes(f)
  return (
    <Box flexDirection="column">
      {header}
      {list.length === 0 ? <Text dimColor>{t('Keine Quellen. Einen Git-Link oben eintragen.', 'No sources. Enter a git link above.')}</Text> : null}
      {list.map(src => {
        const key = src.kind === 'link' ? src.link : `claude:${src.name}`
        const isOpen = opened.includes(key) || !!f
        const mods = src.plugins.filter(p => p.verdict === 'integrate').length
        const nativeCount = src.plugins.filter(p => p.verdict === 'native').length
        const shown = src.plugins.filter(match).sort((x, y) => rank(x) - rank(y))
        return (
          <Box key={`src-${key}`} flexDirection="column" marginBottom={1} borderStyle="round" borderColor={src.error ? 'error' : mods ? 'suggestion' : 'subtle'} paddingX={1}>
            <Box flexDirection="row">
              <Button key={`src-t-${key}`} label={isOpen ? '▾' : '▸'} plain onPress={() => void update($, open, o => (o.includes(key) ? o.filter(x => x !== key) : [...o, key]))} />
              <Text bold>{` ${src.name}`}</Text>
              <Text dimColor>{`  ${src.kind === 'claude' ? t('Claude-Marketplace', 'Claude marketplace') : t('Git-Link', 'git link')} · ${src.plugins.length} Plugins · ${mods} ${t('integrierbar', 'can be integrated')} · ${nativeCount} ${t('nativ', 'native')}`}</Text>
              {src.kind === 'link' ? <Text>{'  '}</Text> : null}
              {src.kind === 'link' ? <Button key={`src-rm-${key}`} label={t('Entfernen', 'Remove')} plain onPress={() => void removeLink($, src.link)} /> : null}
            </Box>
            {src.link && src.link !== src.name ? (
              <Box paddingLeft={3}>
                <Text dimColor>{src.link}</Text>
              </Box>
            ) : null}
            {src.error ? (
              <Box paddingLeft={3}>
                <Text color="error" wrap="wrap">{src.error}</Text>
              </Box>
            ) : null}
            {isOpen
              ? shown.slice(0, ROWS_PER_SOURCE).map(p => {
                  const rk = `p:${key}:${p.name}`
                  const rowOpen = opened.includes(rk)
                  const v = VERDICT[p.verdict ?? 'remote'] ?? VERDICT.remote!
                  const installed = !!p.nativeId && nativeIds.includes(p.nativeId)
                  const canImport = !p.imported && (p.verdict === 'integrate' || p.verdict === null)
                  const canNative = !installed && !p.imported && (p.verdict === 'native' || p.verdict === 'integrate' || p.verdict === null)
                  const actions: unknown[] = []
                  if (!isBusy && canImport) actions.push(<Button key={`imp-${key}-${p.name}`} label={t('Übernehmen', 'Import')} plain onPress={() => void importFrom($, src, p.name)} />)
                  if (!isBusy && p.imported) actions.push(<Button key={`imp-${key}-${p.name}`} label={t('Aktualisieren', 'Update')} plain onPress={() => void importFrom($, src, p.name)} />)
                  if (!isBusy && canNative) actions.push(<Button key={`nat-${key}-${p.name}`} label={p.verdict === 'integrate' ? t('nativ statt Box', 'native instead') : t('Nativ installieren', 'Install natively')} plain onPress={() => void installNative($, src, p)} />)
                  return (
                    <Box key={`pl-${key}-${p.name}`} flexDirection="column" paddingLeft={3}>
                      <Box flexDirection="row">
                        <Button key={`pv-${key}-${p.name}`} plain onPress={() => void update($, open, o => (o.includes(rk) ? o.filter(x => x !== rk) : [...o, rk]))}>
                          <Text color={v.color}>{`${v.mark} `}</Text>
                          <Text bold={p.verdict === 'integrate' || p.verdict === 'native'}>{p.name}</Text>
                        </Button>
                        <Text color={v.color}>{`  ${t(v.label[0], v.label[1])}`}</Text>
                        <Text dimColor wrap="truncate-end">{`  ${trim(p.description, width)}`}</Text>
                        <Text>{'  '}</Text>
                        {p.imported ? <Text color="success">{`✓ ${t('in der Box', 'in the box')}  `}</Text> : installed ? <Text color="success">{`✓ ${t('installiert', 'installed')}  `}</Text> : null}
                        {actions.flatMap((x, i) => (i ? [<Text key={`ag-${key}-${p.name}-${i}`}>{'  '}</Text>, x] : [x])) as any}
                      </Box>
                      {rowOpen ? (
                        <Box flexDirection="column" paddingLeft={4}>
                          {p.reasons.map((r, i) => (
                            <Text key={`rr-${key}-${p.name}-${i}`} color={p.verdict === 'blocked' ? 'error' : 'inactive'} wrap="wrap">{`• ${r}`}</Text>
                          ))}
                          {p.parts.map((x, i) => (
                            <Text key={`rp-${key}-${p.name}-${i}`} color="inactive" wrap="wrap">{`  ${x}`}</Text>
                          ))}
                          {p.verdict === null ? <Text color="inactive">{t('Liegt entfernt: wird beim Übernehmen oder Installieren geholt und geprüft.', 'Remote: fetched and checked on import or install.')}</Text> : null}
                        </Box>
                      ) : null}
                    </Box>
                  )
                })
              : null}
            {isOpen && shown.length > ROWS_PER_SOURCE ? (
              <Box paddingLeft={3}>
                <Text dimColor>{t(`… ${shown.length - ROWS_PER_SOURCE} weitere: Filter benutzen`, `… ${shown.length - ROWS_PER_SOURCE} more: use the filter`)}</Text>
              </Box>
            ) : null}
          </Box>
        )
      })}
      {opened.length ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color="inactive">{t('Zeichen in der Liste (Klick auf den Namen zeigt Gründe und Bestandteile):', 'Marks in the list (click a name for reasons and parts):')}</Text>
          {(['integrate', 'native', 'blocked', 'unsupported', 'remote'] as const).map(k => (
            <Text key={`leg-${k}`} color="inactive">
              <Text color={VERDICT[k]!.color}>{`  ${VERDICT[k]!.mark} `}</Text>
              {k === 'integrate'
                ? t('integriert: in die Box kopiert, schaltbar mit Band und Profilen (nur reine Hook-Mods, ohne Verlust)', 'integrated: copied into the box, switchable, with band and profiles (plain hook mods only, nothing lost)')
                : k === 'native'
                  ? t('nativ verwaltet: bleibt ein eigenes Plugin, hier geschaltet, konfiguriert, aktualisiert, entfernt', 'managed natively: stays a plugin of its own, switched, configured, updated and removed from here')
                  : k === 'blocked'
                    ? t('blockiert: integrieren erst nach Klärung (doppelter Befehl, keine Lizenz …); nativ geht oft trotzdem', 'blocked: integrate only once settled (clashing command, no license …); native often still works')
                    : k === 'unsupported'
                      ? t('nicht unterstützt: die Box kann damit nichts anfangen', 'not supported: nothing the box can do with it')
                      : t('noch nicht geprüft: liegt entfernt, wird beim Übernehmen oder Installieren geprüft', 'not checked yet: remote, checked on import or install')}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  )
}

function rank(p: SourcePlugin): number {
  return { integrate: 0, native: 1, null: 2, blocked: 3, unsupported: 4 }[String(p.verdict) as 'integrate'] ?? 2
}

// How a plugin of a source can be taken, as a mark, a colour and a word.
const VERDICT: Record<string, { mark: string; color: string; label: [string, string] }> = {
  integrate: { mark: '◆', color: 'suggestion', label: ['integriert', 'integrated'] },
  native: { mark: '🔌', color: 'claude', label: ['nativ verwaltet', 'managed natively'] },
  blocked: { mark: '⛔', color: 'error', label: ['blockiert', 'blocked'] },
  unsupported: { mark: '✗', color: 'inactive', label: ['nicht unterstützt', 'not supported'] },
  remote: { mark: '?', color: 'inactive', label: ['noch nicht geprüft', 'not checked yet'] },
}

/** The parts of a plugin as short lines for the window. */
function partsOf(c: any): string[] {
  if (!c) return []
  const out: string[] = []
  const add = (list: unknown, de: string, en: string) => {
    if (Array.isArray(list) && list.length) out.push(`${t(de, en)}: ${list.map(x => (typeof x === 'string' ? x : (x as any).key)).join(', ')}`)
  }
  add(c.modules, 'Hook-Module', 'hook modules')
  add(c.commands, 'Befehle', 'commands')
  add(c.tools, 'Werkzeuge', 'tools')
  add(c.skills, 'Skills', 'skills')
  add(c.commandFiles, 'Befehlsdateien', 'command files')
  add(c.agents, 'Agents', 'agents')
  add(c.mcp, 'MCP-Server', 'MCP servers')
  add(c.lsp, 'LSP-Server', 'LSP servers')
  add(c.classicHooks, 'Settings-Hooks', 'settings hooks')
  add(c.other, 'Weiteres', 'other')
  add(c.options, 'Optionen', 'options')
  add(c.dependencies, 'Abhängigkeiten', 'dependencies')
  return out
}

function trim(s: string, n: number): string {
  return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s
}

// ---------------------------------------------------------------- Helpers

async function home($: EngineInterface): Promise<string> {
  return ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')
}

// ---------------------------------------------------------------- Updates of the original mods

const DIFF_PANE = 'mod-box-diff'

async function checkUpdates($: EngineInterface) {
  if (await read($, busy)) return
  await update($, busy, () => t('Originale werden geprüft …', 'Checking the originals …'))
  try {
    const res = await box($, ['updates'], 600_000)
    if (!res.ok) {
      await update($, report, () => ({ ok: false, title: t('Updates suchen', 'Check for updates'), error: String(res.error ?? '?'), notes: [] }))
      return
    }
    const list: UpdateInfo[] = (res.mods as any[]).map(m => ({
      id: String(m.id),
      status: m.status === 'update' ? 'update' : m.status === 'error' ? 'error' : 'current',
      ...(m.from ? { from: String(m.from) } : {}),
      ...(m.to ? { to: String(m.to) } : {}),
      files: [...(m.changed ?? []), ...(m.added ?? []).map((f: string) => `+ ${f}`), ...(m.removed ?? []).map((f: string) => `- ${f}`)],
      ...(m.error ? { error: String(m.error) } : {}),
    }))
    await update($, updates, () => list)
    await update($, updatedAt, () => Date.now())
    const n = list.filter(u => u.status === 'update').length
    $.ui.toast(n ? t(`${n} Mod(s) mit Updates im Original.`, `${n} mod(s) with updates upstream.`) : t('Alle Originale sind auf unserem Stand.', 'All originals match our copies.'))
  } finally {
    await update($, busy, () => null)
  }
}

async function showDiff($: EngineInterface, id: string) {
  const res = await box($, ['diff', id], 300_000)
  if (!res.ok) {
    await update($, report, () => ({ ok: false, title: `Diff ${id}`, error: String(res.error ?? '?'), notes: [] }))
    return
  }
  await update($, diff, () => ({ id, from: String(res.from), to: String(res.to), text: String(res.diff ?? '') }))
  await $.ui.open({ id: DIFF_PANE, title: `${id}: ${res.from} → ${res.to}`, focus: true, closeOnEscape: true })
}

async function applyUpdate($: EngineInterface, id: string) {
  if (await read($, busy)) return
  await update($, busy, () => t(`${id}: Update wird eingearbeitet und geprüft …`, `${id}: merging and validating the update …`))
  try {
    const res = await box($, ['update', id], 600_000)
    await update($, report, () => ({
      ok: res.ok === true,
      title: t(`Update ${id}`, `Update ${id}`) + (res.from ? ` (${res.from} → ${res.to})` : ''),
      ...(res.error ? { error: String(res.error) } : {}),
      notes: Array.isArray(res.notes) ? res.notes.map(String) : [],
    }))
    if (res.ok) {
      await update($, updates, u => (u ? u.map((x): UpdateInfo => (x.id === id ? { ...x, status: 'current', files: [] } : x)) : u))
      if (res.files > 0) await afterChange($, t(`${id} ist aktualisiert; eigene Anpassungen sind erhalten.`, `${id} is updated; own changes are kept.`))
    }
  } finally {
    await update($, busy, () => null)
  }
}

async function drawUpdates($: EngineInterface, ui: any) {
  const { Box, Text, Button } = ui
  const list = await read($, updates)
  const at = await read($, updatedAt)
  const isBusy = await read($, busy)
  const title = (id: string) => tx(CATALOG.find(m => m.id === id)?.title) || id
  const pending = (list ?? []).filter(u => u.status !== 'current')
  return (
    <Box key="updates" flexDirection="column" marginBottom={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
      <Box flexDirection="row">
        <Text bold color="suggestion">{t('⬆ Updates der Originale', '⬆ Updates of the originals')}</Text>
        <Text>{'   '}</Text>
        {!isBusy ? <Button key="upd-check" label={t('Nach Updates suchen', 'Check for updates')} plain onPress={() => void checkUpdates($)} /> : null}
        {at ? <Text dimColor>{`   ${t('zuletzt', 'last')} ${new Date(at).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit' })}`}</Text> : null}
      </Box>
      {list === null ? (
        <Text dimColor wrap="wrap">
          {t(
            'Vergleicht die Mods aus fremden Repos mit ihrem Original. Ein Update wird in drei Wegen eingearbeitet: eigene Anpassungen bleiben, Konflikte ändern nichts.',
            'Compares the mods from other repos with their original. An update is merged three ways: own changes stay, conflicts change nothing.',
          )}
        </Text>
      ) : pending.length === 0 ? (
        <Text color="success">{t(`✓ Alle ${list.length} Originale sind auf unserem Stand.`, `✓ All ${list.length} originals match our copies.`)}</Text>
      ) : (
        pending.map(u => (
          <Box key={`upd-${u.id}`} flexDirection="column" paddingLeft={2}>
            <Box flexDirection="row">
              <Text color={u.status === 'error' ? 'error' : 'suggestion'} bold>{`${u.status === 'error' ? '✘' : '⬆'} ${title(u.id)}`}</Text>
              {u.status === 'update' ? <Text dimColor>{`  ${u.from} → ${u.to} · ${u.files.length} ${t('Datei(en)', 'file(s)')}`}</Text> : null}
              {u.status === 'update' ? <Text>{'   '}</Text> : null}
              {u.status === 'update' ? <Button key={`upd-diff-${u.id}`} label="Diff" plain onPress={() => void showDiff($, u.id)} /> : null}
              {u.status === 'update' ? <Text>{'  '}</Text> : null}
              {u.status === 'update' && !isBusy ? <Button key={`upd-apply-${u.id}`} label={t('Übernehmen', 'Apply')} plain onPress={() => void applyUpdate($, u.id)} /> : null}
            </Box>
            {u.status === 'error' ? (
              <Box paddingLeft={2}>
                <Text color="error" wrap="wrap">{u.error ?? ''}</Text>
              </Box>
            ) : (
              <Box paddingLeft={2}>
                <Text dimColor wrap="truncate-end">{u.files.join('  ')}</Text>
              </Box>
            )}
          </Box>
        ))
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- Token usage of the mods

function fmtTokens(n: number): string {
  return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n)
}

function fmtUsd(usd: number): string {
  return usd < 0.01 && usd > 0 ? '< $0.01' : '$' + usd.toFixed(2)
}

export function usageText(m: ModUsage): string {
  const cost = m.usd > 0 || m.unpriced === 0 ? ` · ≈ ${fmtUsd(m.usd)}` : ''
  const read = m.cacheRead ? t(` (${fmtTokens(m.cacheRead)} aus dem Cache)`, ` (${fmtTokens(m.cacheRead)} from the cache)`) : ''
  return `${m.calls} ${t(m.calls === 1 ? 'Aufruf' : 'Aufrufe', m.calls === 1 ? 'call' : 'calls')} · ${fmtTokens(tokensOf(m))} Token${read}${cost}`
}

async function resetUsage($: EngineInterface) {
  await update($, usage, () => ({}))
  await $.store.set(USAGE_STORE, {})
  redraw($)
}

async function drawUsage($: EngineInterface, ui: any) {
  const { Box, Text, Button } = ui
  const session = await read($, usage)
  const total = ((await $.store.get(USAGE_STORE).catch(() => null)) ?? {}) as UsageBook
  const s = sumBook(session)
  const all = sumBook(total)
  const title = (toggle: string) => tx(CATALOG.find(m => m.toggle === toggle)?.title) || toggle
  return (
    <Box key="usage" flexDirection="column" marginBottom={1} borderStyle="round" borderColor="warning" paddingX={1}>
      <Box flexDirection="row">
        <Text bold color="warning">{t('💰 Token der Mods', '💰 Mod tokens')}</Text>
        {all.calls ? <Text>{'   '}</Text> : null}
        {all.calls ? <Button key="usage-reset" label={t('Zurücksetzen', 'Reset')} plain onPress={() => void resetUsage($)} /> : null}
      </Box>
      {all.calls === 0 ? (
        <Text dimColor wrap="wrap">
          {t(
            'Noch keine eigenen Modell-Aufrufe. Gezählt werden Next Steps, Heads-up, Catch Me Up, die Übergabe-Notiz und das Warmhalten; die Kosten sind eine Schätzung nach Listenpreis.',
            'No own model calls yet. Counted are Next Steps, Heads-up, Catch Me Up, the handoff note and keep-warm; costs are an estimate from list prices.',
          )}
        </Text>
      ) : (
        <Box flexDirection="column" paddingLeft={2}>
          <Text>{`${t('Diese Sitzung', 'This session')}: ${s.calls ? usageText(s) : t('nichts', 'nothing')}`}</Text>
          <Text dimColor>{`${t('Insgesamt', 'In total')}: ${usageText(all)}`}</Text>
          {Object.entries(total)
            .sort((a, b) => b[1].usd - a[1].usd || tokensOf(b[1]) - tokensOf(a[1]))
            .map(([id, m]) => (
              <Text key={`usage-${id}`} dimColor>{`  ${title(id)}: ${usageText(m)}`}</Text>
            ))}
        </Box>
      )}
    </Box>
  )
}

// ---------------------------------------------------------------- Diagnosis

// Panes and the mod that draws them, to name the right one when a pane render fails.
const PANE_OWNER: Record<string, string> = {
  filetree: 'filetree',
  'visible-compact': 'visibleCompact',
  'catch-me-up': 'catchMeUp',
  'replay-theater': 'replayTheater',
  'savvy-agents': 'savvyProgress',
  'blast-radius': 'blastRadius',
  'ci-watch': 'ciWatch',
  handoff: 'handoff',
  'mod-box-settings': 'settings',
  'mod-box-diff': 'settings',
  'mod-box-secret-allow': 'secretGuard',
}

const DEBUG_FILE = '.claude/mod-box/debug.log'
const MAX_ERRORS = 60

// Failures seen while drawing wait here: a render hook may not write state.
let pendingErrors: HookError[] = []

type TraceLike = ReadonlyArray<{ plugin: string; outcome: string; reason?: string }>

export function failedLinks(trace: TraceLike | undefined, plugin: string): string[] {
  return (trace ?? []).filter(x => x.plugin === plugin && (x.outcome === 'kept' || x.outcome === 'expired' || x.outcome === 'rejected' || (x.outcome === 'skipped' && !x.reason))).map(x => x.outcome)
}

export function candidatesFor(event: string, requestId?: string): string[] {
  if (requestId && PANE_OWNER[requestId]) return [PANE_OWNER[requestId]!]
  return Object.entries(HOOKS)
    .filter(([id, events]) => events.includes(event) && (id === 'settings' || toggleOn(id)))
    .map(([id]) => id)
}

function noteFailures(event: string, trace: TraceLike | undefined, e?: { component?: string; requestId?: string }) {
  try {
    for (const outcome of failedLinks(trace, PLUGIN)) {
      pendingErrors.push({
        at: Date.now(),
        event,
        outcome,
        ...(e?.component ? { component: e.component } : {}),
        ...(e?.requestId ? { requestId: e.requestId } : {}),
        candidates: candidatesFor(event, e?.requestId),
        count: 1,
      })
    }
    if (pendingErrors.length > MAX_ERRORS) pendingErrors = pendingErrors.slice(-MAX_ERRORS)
  } catch {
    // the diagnosis never gets in the way
  }
}

// A box hook beneath threw: inside one plugin that reaches the outer hook as a rejected next(),
// with the message. Noted here; the caller rethrows, so Claude Code handles it as without diagnosis.
export function noteThrown(event: string, err: unknown, e?: { component?: string; requestId?: string }) {
  try {
    const message = (err instanceof Error ? err.message : String(err)).replace(/^HooksError:\s*/, '').slice(0, 300)
    pendingErrors.push({
      at: Date.now(),
      event,
      outcome: 'threw',
      message,
      ...(e?.component ? { component: e.component } : {}),
      ...(e?.requestId ? { requestId: e.requestId } : {}),
      candidates: candidatesFor(event, e?.requestId),
      count: 1,
    })
    if (pendingErrors.length > MAX_ERRORS) pendingErrors = pendingErrors.slice(-MAX_ERRORS)
  } catch {
    // the diagnosis never gets in the way
  }
}

// Writes the collected failures into the state; equal ones are counted, not repeated.
async function flushErrors($: EngineInterface) {
  if (pendingErrors.length === 0) return
  const fresh = pendingErrors
  pendingErrors = []
  await update($, errors, list => {
    let out = [...list]
    for (const f of fresh) {
      const i = out.findIndex(x => x.event === f.event && x.outcome === f.outcome && x.message === f.message && x.requestId === f.requestId && x.component === f.component)
      if (i >= 0) out = out.map((x, j) => (j === i ? { ...x, count: x.count + 1, at: f.at } : x))
      else out.push(f)
    }
    return out.sort((a, b) => b.at - a.at).slice(0, MAX_ERRORS)
  }).catch(() => {})
}

async function runEnvChecks($: EngineInterface) {
  const checks: EnvCheck[] = []
  const run = async (argv: string[]) => $.process.run(argv, { timeoutMs: 20_000 }).catch((err: unknown) => ({ exitCode: -1, stdout: '', stderr: String(err) }))
  const first = (s: string) => s.trim().split('\n')[0] ?? ''
  const isWin = (await $.env.get('OS')) === 'Windows_NT'
  const home = ((await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '').replace(/\\/g, '/')

  const v = await $.session.version().catch(() => null)
  checks.push({ id: 'claude', ok: v ? true : null, text: `Claude Code ${v?.version ?? '?'}` })
  const manifest = await $.fs.read(`${$.plugin.root}/.claude-plugin/plugin.json`).then(x => JSON.parse(String(x))).catch(() => null)
  checks.push({ id: 'box', ok: !!manifest, text: `Mod Box ${manifest?.version ?? '?'} · ${$.plugin.root}` })

  const node = await run(['node', '--version'])
  checks.push({ id: 'node', ok: node.exitCode === 0, text: node.exitCode === 0 ? `node ${first(node.stdout)}` : t('node fehlt: Quellen, Übernehmen und Updates gehen nicht.', 'node missing: sources, import and updates do not work.') })
  const git = await run(['git', '--version'])
  checks.push({ id: 'git', ok: git.exitCode === 0, text: git.exitCode === 0 ? first(git.stdout) : t('git fehlt: Quellen und Updates gehen nicht.', 'git missing: sources and updates do not work.') })
  const gh = await run(['gh', 'auth', 'status'])
  checks.push({
    id: 'gh',
    ok: gh.exitCode === 0,
    text: gh.exitCode === 0 ? t('gh angemeldet (CI-Wächter bereit)', 'gh signed in (CI Watch ready)') : /not found|ENOENT|cannot/i.test(gh.stderr) ? t('gh fehlt: der CI-Wächter kann nichts prüfen.', 'gh missing: CI Watch cannot check anything.') : t('gh nicht angemeldet: gh auth login', 'gh not signed in: gh auth login'),
  })
  if (isWin) {
    const script = String(opts.signScript ?? '').trim().replace(/\\/g, '/') || `${home}/.claude/skills/sign-binary/sign.ps1`
    const hasScript = await $.fs.exists(script).catch(() => false)
    checks.push({ id: 'sign', ok: hasScript, text: hasScript ? t('Signierskript vorhanden', 'sign script present') : t(`Signierskript fehlt: ${script}`, `sign script missing: ${script}`) })
    const pf = ((await $.env.get('ProgramFiles')) ?? 'C:/Program Files').replace(/\\/g, '/')
    const bash = await $.fs.exists(`${pf}/Git/bin/bash.exe`).catch(() => false)
    checks.push({ id: 'bash', ok: bash, text: bash ? t('Git-Bash vorhanden (Blast Radius misst)', 'Git Bash present (Blast Radius measures)') : t('Git-Bash fehlt: Blast Radius kann nicht messen, was ein Befehl träfe.', 'Git Bash missing: Blast Radius cannot measure what a command would hit.') })
  }
  await update($, envChecks, () => checks)

  // The debug log, when Claude Code was started with --debug-file pointing here.
  const debugPath = `${home}/${DEBUG_FILE}`
  const st = await $.fs.stat(debugPath).catch(() => null)
  if (!st) {
    await update($, debugLines, () => null)
  } else {
    const text = st.size > 4 * 1024 * 1024 ? '' : String(await $.fs.read(debugPath).catch(() => ''))
    const lines = text
      .split('\n')
      .filter(l => /mod-box/.test(l) && /skipped|refused|threw|fail|error|did not load|does not validate/i.test(l))
      .slice(-15)
      .map(l => l.replace(/^\S+\s+\[\w+\]\s*/, '').slice(0, 300))
    await update($, debugLines, () => (st.size > 4 * 1024 * 1024 ? [t('Protokoll größer als 4 MB, nicht gelesen.', 'Log larger than 4 MB, not read.')] : lines))
  }
}

async function runValidation($: EngineInterface) {
  if (await read($, busy)) return
  await update($, busy, () => t('Box wird geprüft …', 'Validating the box …'))
  try {
    const res = await box($, ['validate'], 300_000)
    const text = String(res.text ?? res.error ?? '')
    const errorsOnly = text.split('\n').filter(l => /✘|❯/.test(l) && !/warning|description:|author:/i.test(l)).join('\n')
    await update($, validation, () => ({ ok: res.ok === true, text: res.ok ? String(res.binary ?? '') : errorsOnly || text.slice(0, 1500), at: Date.now() }))
  } finally {
    await update($, busy, () => null)
  }
}

async function drawDiagnosis($: EngineInterface, ui: any) {
  const { Box, Text, Button } = ui
  const list = await read($, errors)
  const env = await read($, envChecks)
  const val = await read($, validation)
  const debug = await read($, debugLines)
  const isBusy = await read($, busy)
  const title = (id: string) => (id === 'settings' ? t('Fenster/Kern', 'window/core') : tx(CATALOG.find(m => m.toggle === id)?.title) || id)
  const when = (ms: number) => new Date(ms).toLocaleTimeString(lang === 'en' ? 'en-GB' : 'de-DE', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  const outcomeText = (o: string) =>
    o === 'skipped' ? t('vor next gescheitert, übersprungen', 'failed before next, skipped')
    : o === 'kept' ? t('nach next gescheitert, Ergebnis blieb', 'failed after next, result kept')
    : o === 'expired' ? t('Zeitbudget überschritten', 'ran out of time')
    : o === 'rejected' ? t('abgelehnt', 'rejected')
    : o === 'threw' ? t('Fehler geworfen', 'threw')
    : o

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor={list.length ? 'error' : 'subtle'} paddingX={1}>
        <Box flexDirection="row">
          <Text bold color={list.length ? 'error' : 'success'}>{t('⚡ Hook-Fehler dieser Sitzung', '⚡ Hook failures this session')}</Text>
          {list.length ? <Text>{'   '}</Text> : null}
          {list.length ? <Button key="diag-clear" label={t('Leeren', 'Clear')} plain onPress={() => void update($, errors, () => [])} /> : null}
        </Box>
        {list.length === 0 ? (
          <Text color="success">{t('✓ Keine. Beobachtet werden die Ereignisse, auf die Box-Mods hören.', '✓ None. Watched are the events box mods hook.')}</Text>
        ) : (
          list.map((f, i) => (
            <Box key={`diag-e-${i}`} flexDirection="column" paddingLeft={2}>
              <Text>
                <Text color="error">{`✘ ${f.event}${f.component ? ` (${f.component}${f.requestId ? ` ${f.requestId}` : ''})` : ''}`}</Text>
                <Text dimColor>{`  ${outcomeText(f.outcome)} · ${f.count}× · ${when(f.at)}`}</Text>
              </Text>
              {f.message ? <Text wrap="wrap">{`   ${f.message}`}</Text> : null}
              <Text dimColor wrap="wrap">{`   ${t('in Frage', 'suspects')}: ${f.candidates.map(title).join(', ') || '?'}`}</Text>
            </Box>
          ))
        )}
      </Box>

      <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="planMode" paddingX={1}>
        <Box flexDirection="row">
          <Text bold color="planMode">{t('🖥 Umgebung', '🖥 Environment')}</Text>
          <Text>{'   '}</Text>
          <Button key="diag-env" label={t('Prüfen', 'Check')} plain onPress={() => void runEnvChecks($)} />
        </Box>
        {env === null ? <Text dimColor>{t('Noch nicht geprüft.', 'Not checked yet.')}</Text> : null}
        {(env ?? []).map(c => (
          <Text key={`diag-env-${c.id}`}>
            <Text color={c.ok === true ? 'success' : c.ok === false ? 'error' : 'warning'}>{c.ok === true ? '  ✓ ' : c.ok === false ? '  ✘ ' : '  · '}</Text>
            <Text>{c.text}</Text>
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="suggestion" paddingX={1}>
        <Box flexDirection="row">
          <Text bold color="suggestion">{t('✓ Box prüfen', '✓ Validate the box')}</Text>
          <Text>{'   '}</Text>
          {!isBusy ? <Button key="diag-validate" label="claude plugin validate" plain onPress={() => void runValidation($)} /> : null}
        </Box>
        {val ? (
          val.ok ? (
            <Text color="success">{`  ✓ ${t('bestanden', 'passed')} · ${when(val.at)}${val.text ? ` · ${val.text}` : ''}`}</Text>
          ) : (
            <Text color="error" wrap="wrap">{`  ✘ ${val.text}`}</Text>
          )
        ) : null}
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="subtle" paddingX={1}>
        <Text bold color="inactive">{t('📜 Debug-Protokoll', '📜 Debug log')}</Text>
        {debug === null ? (
          <Text dimColor wrap="wrap">
            {t(
              `Die Gründe eines Fehlers stehen nur im Debug-Protokoll. Claude Code dafür so starten: claude --debug-file ~/${DEBUG_FILE} – dann zeigt dieser Reiter hier die letzten Fehlerzeilen der Box (nach „Prüfen“).`,
              `The reasons of a failure are only in the debug log. Start Claude Code like this: claude --debug-file ~/${DEBUG_FILE} – this tab then shows the box's last error lines here (after "Check").`,
            )}
          </Text>
        ) : debug.length === 0 ? (
          <Text color="success">{t('✓ Keine Fehlerzeilen der Box im Protokoll.', '✓ No error lines of the box in the log.')}</Text>
        ) : (
          debug.map((l, i) => (
            <Text key={`diag-dbg-${i}`} dimColor wrap="wrap">{`  ${l}`}</Text>
          ))
        )}
      </Box>
    </Box>
  )
}
