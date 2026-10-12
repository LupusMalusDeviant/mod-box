// Modified for mod-box (https://github.com/LupusMalusDeviant/mod-box): state keys under mod-box with prefix cm2, {} matchers, $.plugin.root paths into mods/codebase-map/.
// Original: https://github.com/LupusMalusDeviant/codebase-map (version 0.4.0).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BlueprintStatus, MapData, MapFeature } from '../types'
import {
  BLUEPRINT_DIR,
  CODE_ONLY,
  INDEX_PATH,
  blueprintSlugOf,
  buildMap,
  featureOf,
  parseStamp,
  relativeTo,
} from './blueprint'
import { withBlock, withoutBlock } from './claudemd'
import { MAPPER_TRIGGER, TEXT, langOf, mapperHint } from './i18n'
import type { Lang } from './i18n'
import { renderSvg } from './svg'

const PANE = 'codebase-map'
// Werkzeuge, nach denen sich Code, HEAD oder Blueprint geändert haben können.
const CHANGING = new Set(['Edit', 'Write', 'NotebookEdit', 'Bash', 'PowerShell'])
// Ohne Änderung in der Session prüft turn.complete höchstens so oft (ms) nach, ob jemand außerhalb committet hat.
const IDLE_REFRESH_MS = 5 * 60_000

const status = atom({ plugin: 'mod-box', key: 'cm2_status' } as const, null)
const dismissedAt = atom({ plugin: 'mod-box', key: 'cm2_dismissedAt' } as const, null)
const mapData = atom({ plugin: 'mod-box', key: 'cm2_map' } as const, null)
const selected = atom({ plugin: 'mod-box', key: 'cm2_selected' } as const, null)
const active = atom({ plugin: 'mod-box', key: 'cm2_active' } as const, [])
const touched = atom({ plugin: 'mod-box', key: 'cm2_touched' } as const, {})
const unassigned = atom({ plugin: 'mod-box', key: 'cm2_unassigned' } as const, [])

const join = (root: string, rel: string) => `${root.replace(/[\\/]+$/, '')}/${rel}`

const git = async ($: EngineInterface, root: string, args: string[]) => {
  const ran = await $.process.run(['git', ...args], { cwd: root })
  return ran.exitCode === 0 ? ran.stdout.trim() : null
}

const readOrNull = async ($: EngineInterface, path: string) =>
  (await $.fs.exists(path)) ? await $.fs.read(path) : null

const checkStatus = async ($: EngineInterface, root: string, index: string): Promise<BlueprintStatus | null> => {
  const head = await git($, root, ['rev-parse', 'HEAD'])
  if (head === null) return null

  const stamp = parseStamp(index)
  if (stamp === null) return { kind: 'no-stamp', head }
  if (head.startsWith(stamp)) return { kind: 'fresh', head }
  if ((await git($, root, ['cat-file', '-t', stamp])) !== 'commit') {
    return { kind: 'unknown-stamp', head, stamp }
  }

  const commits = Number(await git($, root, ['rev-list', '--count', `${stamp}..HEAD`, ...CODE_ONLY])) || 0
  const changed = await git($, root, ['diff', '--name-only', `${stamp}..HEAD`, ...CODE_ONLY])
  const files = changed ? changed.split('\n').filter(Boolean).length : 0

  return commits === 0 || files === 0 ? { kind: 'fresh', head } : { kind: 'behind', head, stamp, commits, files }
}

const loadMap = async ($: EngineInterface, root: string, index: string): Promise<MapData> => {
  const features: Record<string, string> = {}
  for (const entry of await $.fs.list(join(root, BLUEPRINT_DIR))) {
    if (entry.kind === 'file' && entry.name.endsWith('.md') && entry.name !== 'INDEX.md') {
      features[entry.name.slice(0, -3)] = await $.fs.read(join(root, `${BLUEPRINT_DIR}/${entry.name}`))
    }
  }
  return buildMap(index, features)
}

// Hält den Verweis-Block in CLAUDE.md aktuell; .claude/CLAUDE.md nur, wenn es keine im Wurzelordner gibt.
const wireClaudeMd = async ($: EngineInterface, root: string, lang: Lang) => {
  const top = join(root, 'CLAUDE.md')
  const nested = join(root, '.claude/CLAUDE.md')
  const target = !(await $.fs.exists(top)) && (await $.fs.exists(nested)) ? nested : top
  const next = withBlock(await readOrNull($, target), lang)
  if (next === null) return
  await $.fs.write(target, next)
  $.ui.toast(TEXT[lang].toast(target === top ? 'CLAUDE.md' : '.claude/CLAUDE.md'))
}

// Abgeschaltete CLAUDE.md-Pflege räumt ihren Block wieder weg, in beiden möglichen Dateien.
const unwireClaudeMd = async ($: EngineInterface, root: string, lang: Lang) => {
  const files: Array<[string, string]> = [['CLAUDE.md', join(root, 'CLAUDE.md')], ['.claude/CLAUDE.md', join(root, '.claude/CLAUDE.md')]]
  for (const [rel, target] of files) {
    const next = withoutBlock(await readOrNull($, target))
    if (next === null) continue
    await $.fs.write(target, next)
    $.ui.toast(TEXT[lang].toastRemoved(rel))
  }
}

const refresh = async ($: EngineInterface, isWiring: boolean, lang: Lang) => {
  const root = await $.session.root()
  const index = await readOrNull($, join(root, INDEX_PATH)).catch(() => null)
  if (index === null) {
    await update($, status, () => null)
    await update($, mapData, () => null)
    return
  }
  const [nextStatus, nextMap] = await Promise.all([
    checkStatus($, root, index).catch(() => null),
    loadMap($, root, index).catch(() => null),
  ])
  await update($, status, () => nextStatus)
  await update($, mapData, () => nextMap)
  if (isWiring) await wireClaudeMd($, root, lang).catch(() => undefined)
}

const openMap = ($: EngineInterface, lang: Lang) => $.ui.open({ id: PANE, title: TEXT[lang].paneTitle })

export const register: Register = (on, options) => {
  const isWiring = options.claudeMd !== 'off'
  const lang = langOf(options.language)
  const t = TEXT[lang]

  // Modulvariablen beginnen bei jedem Neuladen von vorn; session.start feuert dann erneut und prüft sofort.
  let isDirty = true
  let refreshedAt = 0

  on('session.start', {}, async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'codebase-map', description: t.commandDescription })
    if (!isWiring) await unwireClaudeMd($, await $.session.root(), lang).catch(() => undefined)
    await refresh($, isWiring, lang)
    refreshedAt = await $.clock.now()
    isDirty = false
    return started
  })

  on('turn.complete', {}, async ($, e, next) => {
    const done = await next(e)
    const now = await $.clock.now()
    if (!isDirty && now - refreshedAt < IDLE_REFRESH_MS) return done
    await refresh($, isWiring, lang)
    refreshedAt = now
    isDirty = false
    return done
  })

  on('command.run', { command: 'codebase-map' }, async ($, e) => {
    const action = e.args.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
    // Mod Box: "update <feature>" / "publish <feature>" prepare the prompt for that one feature.
    const rest = e.args.trim().slice(action.length).trim()
    if (rest !== '' && (action === 'update' || action === 'publish')) {
      const map = await read($, mapData)
      const feature = map?.features.find(one => one.name.toLowerCase() === rest.toLowerCase() || one.slug === rest.toLowerCase())
      if (map === null || feature === undefined) return { text: t.commandUsage }
      await $.prompt.fill({
        text: action === 'update' ? t.promptUpdateFeature(feature.name) : t.promptPublishFeature(feature.name, map.confluence.pageId !== null),
      })
      return { text: t.commandPrepared }
    }
    const prompts: Record<string, string> = {
      create: t.promptCreate,
      update: t.promptUpdate,
      check: t.promptCheck,
      publish: t.promptPublishAll,
    }
    if (action === '') {
      await openMap($, lang)
      return { text: t.commandDone }
    }
    if (prompts[action] === undefined) return { text: t.commandUsage }
    await $.prompt.fill({ text: prompts[action] })
    return { text: t.commandPrepared }
  })

  // Statt eines Skills: Nur Prompts, die nach Blueprint-Arbeit klingen, bekommen den Verweis auf die Anleitung.
  on('prompt.submit', {}, async ($, e, next) => {
    if (e.text.trimStart().startsWith('/') || !MAPPER_TRIGGER.test(e.text)) return next(e)
    // Template-Form, damit der Mod-Box-Import den Pfad auf mods/codebase-map/ umschreiben kann.
    const dir = `${$.plugin.root}/mods/codebase-map/mapper`.replace(/\\/g, '/').replace(/\/{2,}/g, '/')
    return next({ ...e, context: [...(e.context ?? []), mapperHint(dir)] })
  })

  // Live: welches Feature Claude (oder ein Subagent) gerade bearbeitet.
  on('tool.call', {}, async ($, e, next) => {
    if (CHANGING.has(e.tool)) isDirty = true
    const path = e.tool === 'Edit' || e.tool === 'Write' ? e.file_path : e.tool === 'NotebookEdit' ? e.notebook_path : null
    if (path === null) return next(e)

    const rel = relativeTo(await $.session.root(), path)
    const map = await read($, mapData)
    if (rel === null || map === null) return next(e)

    const ownBlueprint = blueprintSlugOf(rel)
    const slug = ownBlueprint === null ? featureOf(map, rel) : null
    const id = e.tool_use_id
    await update($, active, list => [...list, { id, slug, file: rel, agentId: e.agentId ?? null }])
    try {
      const ran = await next(e)
      const isDone = ran.deny === undefined && ran.isError !== true
      if (isDone && ownBlueprint !== null) {
        await update($, touched, all => Object.fromEntries(Object.entries(all).filter(([key]) => key !== ownBlueprint)))
      } else if (isDone && slug !== null) {
        await update($, touched, all => ({ ...all, [slug]: [...new Set([...(all[slug] ?? []), rel])] }))
      } else if (isDone && ownBlueprint === null) {
        await update($, unassigned, list => [...new Set([...list, rel])].slice(-50))
      }
      return ran
    } finally {
      await update($, active, list => list.filter(one => one.id !== id))
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const current = await read($, status)
    const isQuiet =
      e.props.hasSurvey ||
      current === null ||
      current.kind === 'fresh' ||
      (await read($, dismissedAt)) === current.head

    if (isQuiet) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const message =
      current.kind === 'behind'
        ? t.behind(current.commits, current.files, current.stamp.slice(0, 8))
        : current.kind === 'unknown-stamp'
          ? t.unknownStamp(current.stamp.slice(0, 8))
          : t.noStamp

    return (
      <Box>
        <Text color="yellow">{`📘 ${message} `}</Text>
        <Button key="update" label={t.prepare} onPress={() => $.prompt.fill({ text: t.promptUpdate })} />
        <Text> </Text>
        <Button key="map" label={t.map} onPress={() => openMap($, lang)} />
        <Text> </Text>
        <Button key="dismiss" label={t.dismiss} onPress={() => update($, dismissedAt, () => current.head)} />
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { Box, Button, Markdown, Text } = elements
    const map = await read($, mapData)

    if (map === null || map.features.length === 0) {
      return (
        <Box flexDirection="column">
          <Text>{t.noBlueprint}</Text>
          <Button key="create" label={t.createBlueprint} onPress={() => $.prompt.fill({ text: t.promptCreate })} />
        </Box>
      )
    }

    const [current, chosen, running, changed, loose] = await Promise.all([
      read($, status),
      read($, selected),
      read($, active),
      read($, touched),
      read($, unassigned),
    ])
    const busy = new Set(running.flatMap(one => (one.slug === null ? [] : [one.slug])))
    const stateOf = (slug: string) =>
      busy.has(slug) ? 'active' : changed[slug] ? 'touched' : slug === chosen ? 'selected' : 'idle'
    const pick = map.features.find(f => f.slug === chosen) ?? null
    const statusLine =
      current === null ? t.statusNoGit
        : current.kind === 'fresh' ? t.statusFresh
          : current.kind === 'behind' ? t.statusBehind(current.commits, current.files)
            : t.statusBadStamp
    const marker = (slug: string) => ({ active: '●', touched: '◆', selected: '▸', idle: '·' })[stateOf(slug)]
    // resolve liefert für Elemente, die eine Oberfläche nicht kennt, einen leeren Platzhalter: nach Oberfläche entscheiden.
    const Svg = e.surface !== 'terminal' && 'Svg' in elements ? elements.Svg : undefined
    const rows = map.features.map(f => {
      const uses = f.deps.length > 0 ? `  → ${f.deps.map(dep => nameOf(map, dep)).join(', ')}` : ''
      return `${marker(f.slug)} ${f.name}${uses}`
    })
    const graph = renderSvg(map, stateOf, t.legend)
    const confluence = map.confluence
    const isIndexPublished = confluence.pageId !== null

    return (
      <Box flexDirection="column">
        <Text bold>{`${t.features(map.features.length)} · ${statusLine}`}</Text>
        <Text dimColor>{confluenceLine(map, lang)}</Text>
        <Button
          key="confluence"
          label={confluence.isOptedIn ? t.updateConfluence : t.publishAll}
          onPress={() => $.prompt.fill({ text: confluence.isOptedIn ? t.promptUpdateConfluence : t.promptPublishAll })}
        />
        {Svg !== undefined ? (
          <Svg key="graph" source={graph.source} width={graph.width} height={graph.height} isInteractive alt={t.graphAlt(map.features.length)} />
        ) : (
          <Text>{`● ${t.legend.active} · ◆ ${t.legend.touched}\n${rows.join('\n')}`}</Text>
        )}
        {running.length > 0 && (
          <Text color="yellow">
            {running.map(one => t.editing(one.agentId === null ? 'main' : 'sub', one.file, one.slug === null ? null : nameOf(map, one.slug))).join('\n')}
          </Text>
        )}
        {loose.length > 0 && <Text dimColor>{t.unassigned(loose.slice(-5).join(', '))}</Text>}
        {e.surface !== 'mobile' && picker(elements, t.feature, map.features, pick?.slug, slug => update($, selected, () => slug))}
        {pick !== null && <Markdown key="detail" text={detail(map, pick, changed[pick.slug] ?? [], lang)} />}
        {pick !== null && (
          <Button key="refresh-feature" label={t.updateFeature} onPress={() => $.prompt.fill({ text: t.promptUpdateFeature(pick.name) })} />
        )}
        {pick !== null && (
          <Button key="publish-feature" label={t.publishFeature} onPress={() => $.prompt.fill({ text: t.promptPublishFeature(pick.name, isIndexPublished) })} />
        )}
      </Box>
    )
  })
}

const confluenceLine = (map: MapData, lang: Lang) =>
  !map.confluence.isOptedIn ? TEXT[lang].confluenceOff
    : map.confluence.pageId === null ? TEXT[lang].confluencePlanned
      : TEXT[lang].confluenceOn(map.confluence.pageId)

const nameOf = (map: MapData, slug: string) => map.features.find(f => f.slug === slug)?.name ?? slug

// Element-Konstruktoren kommen von der Oberfläche; ein Picker nur, wo es Select gibt (nicht mobil).
const picker = (
  elements: ReturnType<EngineInterface['ui']['resolve']>,
  label: string,
  features: MapFeature[],
  value: string | undefined,
  onSelect: (slug: string) => void,
) => {
  if (!('Select' in elements)) return null
  const Picker = elements.Select
  return (
    <Picker
      key="feature"
      label={label}
      options={features.map(f => ({ value: f.slug, label: f.name }))}
      value={value}
      onSelect={slug => onSelect(slug)}
    />
  )
}

const detail = (map: MapData, f: MapFeature, edited: string[], lang: Lang) => {
  const t = TEXT[lang]
  const users = map.features.filter(other => other.deps.includes(f.slug)).map(other => other.name)
  const lines = [
    `### ${f.name}`,
    f.summary,
    '',
    `**${t.uses}:** ${f.deps.map(dep => nameOf(map, dep)).join(', ') || '-'}  `,
    `**${t.usedBy}:** ${users.join(', ') || '-'}`,
    '',
    `**${t.files}** (\`docs/blueprints/${f.slug}.md\`):`,
    ...f.files.map(file => `- \`${file}\`${edited.includes(file) ? ' ✏️' : ''}`),
    ...edited.filter(file => !f.files.includes(file)).map(file => `- \`${file}\` ✏️ ${t.newFile}`),
  ]
  if (edited.length > 0) lines.push('', `> ${t.staleNote}`)
  return lines.join('\n')
}
