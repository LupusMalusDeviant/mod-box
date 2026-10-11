// Modified for mod-box (https://github.com/LupusMalusDeviant/mod-box): state, matchers and paths rewritten for the single plugin.
// Original: https://github.com/nvsravank/visible-compact (commit b598036).
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chunk, CompactMeta, Side, Theme, ViewMode } from '../types'
import { chunkMessages } from './chunk'

/** Chunks per file: 100 × 4,000 chars stays well under the 4 MiB a file read or write allows. */
export const FILE_CHUNKS = 100

type Storage = 'temp' | 'home'
// From the plugin's settings; a change there reloads the module, so register sets it again.
let storage: Storage = 'temp'

const baseDir = async ($: EngineInterface) => {
  if (storage === 'home') {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? '.'
    return `${home}/.claude/visible-compact`
  }
  const temp =
    (await $.env.get('TMPDIR')) ?? (await $.env.get('TEMP')) ?? (await $.env.get('TMP')) ?? '/tmp'
  return `${temp.replace(/[\\/]$/, '')}/visible-compact`
}

const sessionDir = async ($: EngineInterface) => `${await baseDir($)}/sessions/${await $.session.id()}`

const chunkFile = (dir: string, id: string, side: Side, file: number) =>
  `${dir}/${id}.${side}.${file}.json`

export const readIndex = async ($: EngineInterface): Promise<CompactMeta[]> => {
  const path = `${await sessionDir($)}/index.json`
  if (!(await $.fs.exists(path))) return []
  try {
    return JSON.parse(await $.fs.read(path)) as CompactMeta[]
  } catch {
    return []
  }
}

export const saveCompaction = async (
  $: EngineInterface,
  meta: CompactMeta,
  chunks: Record<Side, Chunk[]>,
): Promise<CompactMeta[]> => {
  const dir = await sessionDir($)
  for (const side of ['before', 'after'] as const) {
    const list = chunks[side]
    for (let file = 0; file * FILE_CHUNKS < list.length; file++)
      await $.fs.write(
        chunkFile(dir, meta.id, side, file),
        JSON.stringify(list.slice(file * FILE_CHUNKS, (file + 1) * FILE_CHUNKS)),
      )
  }
  const index = [...(await readIndex($)), meta]
  await $.fs.write(`${dir}/index.json`, JSON.stringify(index))

  return index
}

// A few files' worth of chunks, so paging back and forth doesn't re-read.
const cache = new Map<string, Chunk[]>()

export const readChunks = async (
  $: EngineInterface,
  id: string,
  side: Side,
  from: number,
  count: number,
): Promise<Chunk[]> => {
  const dir = await sessionDir($)
  const out: Chunk[] = []
  for (let at = from; at < from + count; ) {
    const file = Math.floor(at / FILE_CHUNKS)
    const path = chunkFile(dir, id, side, file)
    let list = cache.get(path)
    if (list === undefined) {
      if (!(await $.fs.exists(path))) break
      list = JSON.parse(await $.fs.read(path)) as Chunk[]
      cache.set(path, list)
      if (cache.size > 6) cache.delete(cache.keys().next().value!)
    }
    const offset = at - file * FILE_CHUNKS
    const taken = list.slice(offset, offset + (from + count - at))
    if (taken.length === 0) break
    out.push(...taken)
    at += taken.length
  }

  return out
}

const PANE = 'visible-compact'
const TITLE = 'Your compaction history'
const COMMAND = 'show-last-compact'
// Below this many body columns the two sides stack instead of sitting side by side.
const SIDE_BY_SIDE_MIN = 80
// Chunks drawn per page of each column; at 4,000 chars a chunk, a page is at most 40k chars.
const PAGE_CHUNKS = 10
// Plugins aren't told the app's theme, so the person picks with the ☀/☾ toggle (as in
// multirepo-diff-mod). Each side's color heads its column and marks its number in the tokens
// line. Solid hex only: the desktop did not draw rgba().
type Palette = Record<Side | 'user' | 'assistant', string>
const PALETTES: Record<Theme, Palette> = {
  light: { after: '#1a7f37', before: '#9a6700', user: '#0969da', assistant: '#8250df' },
  dark: { after: '#7ee787', before: '#e3b341', user: '#79c0ff', assistant: '#d2a8ff' },
}
const THEME_STORE_NAME = 'theme'

const index = atom({ plugin: 'mod-box', key: 'vc_index' } as const, [])
const selected = atom({ plugin: 'mod-box', key: 'vc_selected' } as const, null)
const view = atom({ plugin: 'mod-box', key: 'vc_view' } as const, 'both')
const pages = atom({ plugin: 'mod-box', key: 'vc_pages' } as const, { before: 0, after: 0 })
const theme = atom({ plugin: 'mod-box', key: 'vc_theme' } as const, 'light')

const toggleTheme = async ($: EngineInterface) => {
  const next = await update($, theme, current => (current === 'light' ? 'dark' : 'light'))
  await $.store.set(THEME_STORE_NAME, next)
}

const tokens = (n?: number) =>
  n === undefined ? '?' : n >= 1000 ? `${Math.round(n / 1000).toLocaleString()}k` : String(n)

const clock = (at: number) => new Date(at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })

const who = (meta: CompactMeta) => (meta.agentId === undefined ? 'main' : (meta.agentLabel ?? `agent ${meta.agentId}`))

const optionLabel = (meta: CompactMeta) => `${clock(meta.at)} · ${who(meta)} · ${meta.trigger}`

const agentLabel = async ($: EngineInterface, agentId: string) => {
  const agent = (await $.agent.list()).find(a => a.id === agentId)

  return agent === undefined ? undefined : `${agent.type}: ${agent.description}`
}

const show = async ($: EngineInterface, id: string | null) => {
  await update($, selected, () => id)
  await update($, pages, () => ({ before: 0, after: 0 }))
}

export const register: Register = (on, options) => {
  storage = options.storage === 'home' ? 'home' : 'temp'

  on('session.start', {}, async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Reopen "Your compaction history": what was compacted, side by side with what came back',
    })
    // Compactions live on disk under the session id, so a restart or --resume picks them up again.
    const saved = await readIndex($)
    await update($, index, () => saved)
    // Restore the light/dark pick saved in an earlier session.
    const savedTheme = await $.store.get(THEME_STORE_NAME)
    if (savedTheme === 'light' || savedTheme === 'dark') await update($, theme, () => savedTheme)

    return next(e)
  })

  // /clear goes on under a new session id, with nothing compacted yet.
  on('session.end', {}, async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, index, () => [])
      await show($, null)
    }

    return next(e)
  })

  on('session.compact', {}, async ($, e, next) => {
    const started = Date.now()
    const result = await next(e)
    if (e.trigger === 'precompute' || result.skip !== undefined) return result

    const before = chunkMessages(e.messages)
    const after = chunkMessages(result.messages)
    const meta: CompactMeta = {
      id: `${started.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      at: started,
      durationMs: Date.now() - started,
      trigger: e.trigger,
      agentId: e.agentId,
      agentLabel: e.agentId === undefined ? undefined : await agentLabel($, e.agentId),
      instructions: e.instructions,
      tokensBefore: result.tokensBefore,
      tokensAfter: result.tokensAfter,
      usage: result.usage,
      messages: { before: e.messages.length, after: result.messages.length },
      chunks: { before: before.length, after: after.length },
    }
    try {
      const saved = await saveCompaction($, meta, { before, after })
      await update($, index, () => saved)
    } catch (error) {
      $.ui.toast(`visible-compact: could not save the compaction (${String(error)})`)

      return result
    }
    // Your own /compact opens the pane on it; auto and subagent compactions just join the picker.
    if (e.trigger === 'manual' && e.agentId === undefined) {
      await show($, null)
      void $.ui.open({ id: PANE, title: TITLE })
    }

    return result
  })

  on('command.run', { command: COMMAND }, async $ => {
    if ((await read($, index)).length === 0)
      return { text: 'No compaction recorded for this session yet. Run /compact first.' }
    await show($, null)
    await $.ui.open({ id: PANE, title: TITLE })

    return { text: 'Opened "Your compaction history".' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button, Markdown } = ui
    const all = await read($, index)
    if (all.length === 0) return <Text dimColor>No compaction recorded for this session yet.</Text>

    const pick = await read($, selected)
    const meta = all.find(m => m.id === pick) ?? all[all.length - 1]!
    const mode = await read($, view)
    const page = await read($, pages)
    const columns = e.props.bodyColumns
    const colorTheme = await read($, theme)
    const colors = PALETTES[colorTheme]

    const setView = (next: ViewMode) => () => void update($, view, () => next)
    // Laid out as the columns are: after on the left, before on the right.
    // A Button's label is one plain string, so the selected mode is drawn as bold
    // text in its column's color instead; pressing it would change nothing anyway.
    const modes = [
      { mode: 'after' as const, label: '◧ After', selected: <Text bold color={colors.after}>◧ After</Text> },
      {
        mode: 'both' as const,
        label: '◫ Both',
        selected: (
          <Text>
            <Text bold color={colors.after}>◫ Bo</Text>
            <Text bold color={colors.before}>th</Text>
          </Text>
        ),
      },
      { mode: 'before' as const, label: '◨ Before', selected: <Text bold color={colors.before}>◨ Before</Text> },
    ]
    const toggle = (
      <Box gap={1}>
        {modes.map(m =>
          m.mode === mode ? (
            <Box key={m.mode}>{m.selected}</Box>
          ) : (
            <Button key={m.mode} plain dimColor onPress={setView(m.mode)}>
              {m.label}
            </Button>
          ),
        )}
        {/* Shows the mode a press switches to: ☾ while light, ☀ while dark. */}
        <Button plain onPress={() => void toggleTheme($)}>
          {colorTheme === 'light' ? '☾' : '☀'}
        </Button>
      </Box>
    )

    const newestFirst = [...all].reverse()
    const options = newestFirst.map((m, i) => ({
      value: m.id,
      label: `${i === 0 ? '(latest) ' : ''}${optionLabel(m)}`,
    }))
    const pickId = (id: string) => void show($, id === newestFirst[0]?.id ? null : id)
    // Mobile draws no Select: there the latest few are buttons instead.
    const picker =
      'Select' in ui ? (
        <ui.Select key="compaction" label="Compaction: " value={meta.id} options={options} onSelect={pickId} />
      ) : (
        <Box flexDirection="column">
          {options.slice(0, 5).map(o => (
            <Button key={o.value} plain dimColor={o.value !== meta.id} onPress={() => pickId(o.value)}>
              {o.label}
            </Button>
          ))}
        </Box>
      )

    // When, who and what triggered it are in the picker; message counts head each column.
    const stats = (
      <Box justifyContent="space-between">
        {/* Only the words are dim, so the bold numbers don't inherit it. */}
        <Text>
          <Text dimColor>Tokens reduced to </Text>
          <Text bold color={colors.after}>
            {tokens(meta.tokensAfter)}
          </Text>
          <Text dimColor> from </Text>
          <Text bold color={colors.before}>
            {tokens(meta.tokensBefore)}
          </Text>
        </Text>
        <Text dimColor>Took: {(meta.durationMs / 1000).toFixed(1)}s</Text>
      </Box>
    )

    // `gap` is the blank rows above the column, so a stacked Before stands apart from After's end.
    const column = async (side: Side, width: number, gap = 1) => {
      const total = meta.chunks[side]
      const pageCount = Math.max(1, Math.ceil(total / PAGE_CHUNKS))
      const at = Math.min(page[side], pageCount - 1)
      const chunks = await readChunks($, meta.id, side, at * PAGE_CHUNKS, PAGE_CHUNKS)
      const turn = (by: number) => () =>
        void update($, pages, p => ({ ...p, [side]: Math.max(0, Math.min(pageCount - 1, at + by)) }))

      const pager = pageCount > 1 && (
        <Box gap={1}>
          <Button plain dimColor={at === 0} onPress={turn(-1)}>
            ‹ Previous
          </Button>
          <Text dimColor>
            {at + 1}/{pageCount}
          </Text>
          <Button plain dimColor={at === pageCount - 1} onPress={turn(1)}>
            Next ›
          </Button>
        </Box>
      )

      return (
        <Box flexDirection="column" width={width} paddingRight={1} marginTop={gap}>
          <Box justifyContent="space-between">
            <Text bold underline color={colors[side]}>
              {side === 'after' ? 'After' : 'Before'} ({meta.messages[side]} msgs, {total} chunks)
            </Text>
            {pager}
          </Box>
          {chunks.length === 0 && <Text dimColor>(empty)</Text>}
          {chunks.map((chunk: Chunk) => (
            <Box flexDirection="column" marginTop={1}>
              <Text dimColor>
                <Text bold color={chunk.role === 'user' ? colors.user : colors.assistant}>
                  {chunk.role}
                </Text>{' '}
                · msg {chunk.m + 1}
                {chunk.n > 1 ? ` · part ${chunk.i + 1}/${chunk.n}` : ''}
              </Text>
              <Markdown text={chunk.text} />
            </Box>
          ))}
          {pager && (
            <Box marginTop={1} justifyContent="flex-end">
              {pager}
            </Box>
          )}
        </Box>
      )
    }

    const isSideBySide = mode === 'both' && columns >= SIDE_BY_SIDE_MIN
    const half = isSideBySide ? Math.floor(columns / 2) : columns
    const body =
      mode === 'after' ? (
        await column('after', columns)
      ) : mode === 'before' ? (
        await column('before', columns)
      ) : (
        <Box flexDirection={isSideBySide ? 'row' : 'column'}>
          {await column('after', half)}
          {await column('before', half, isSideBySide ? 1 : 3)}
        </Box>
      )

    return (
      <Box flexDirection="column">
        <Box justifyContent="space-between">
          {picker}
          {toggle}
        </Box>
        {stats}
        <Box marginTop={1}>
          <Text wrap="wrap">
            <Text bold>Instructions: </Text>
            {meta.instructions ?? <Text dimColor>none typed after /compact (the default summary prompt only)</Text>}
          </Text>
        </Box>
        {body}
      </Box>
    )
  })
}
