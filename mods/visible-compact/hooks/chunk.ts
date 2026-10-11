import type { SessionMessage } from 'claude-code'

import type { Chunk } from '../types'

// Well under the 10,000 characters a Markdown element draws.
export const CHUNK_CHARS = 4000

/** Splits one over-long piece at the last match of `at` before the limit, else hard. */
const cut = (text: string, max: number, at: RegExp): string[] => {
  const out: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    let end = -1
    for (const match of window.matchAll(at)) end = match.index + match[0].length
    if (end <= 0) end = max
    out.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest.length > 0) out.push(rest)

  return out
}

/** Cuts prose into paragraphs no longer than `max`: at line breaks, then spaces, then anywhere. */
const prosePieces = (text: string, max: number): string[] =>
  text
    .split(/(?<=\n\s*\n)/)
    .flatMap(p => (p.length <= max ? [p] : cut(p, max, /\n/g)))
    .flatMap(p => (p.length <= max ? [p] : cut(p, max, / /g)))

// An opening code fence: up to three spaces, then three or more backticks or tildes.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/

type Fence = { open: string; close: string }

/** A closing fence line: the same character as the opening run, at least as many. */
const closesFence = (marker: string, line: string) =>
  new RegExp('^ {0,3}' + marker[0] + '{' + marker.length + ',}\\s*$').test(line)
type Segment = { text: string; fence?: Fence }

/** Splits text into prose and fenced code blocks, each block whole with its fence lines. */
const segments = (text: string): Segment[] => {
  const out: Segment[] = []
  let prose = ''
  let block: { text: string; open: string; marker: string } | undefined
  for (const line of text.split(/(?<=\n)/)) {
    if (block === undefined) {
      const open = FENCE_OPEN.exec(line)
      if (open === null) {
        prose += line
        continue
      }
      if (prose.length > 0) out.push({ text: prose })
      prose = ''
      block = { text: line, open: line.replace(/\n$/, ''), marker: open[1]! }
      continue
    }
    block.text += line
    if (closesFence(block.marker, line)) {
      out.push({ text: block.text, fence: { open: block.open, close: block.marker } })
      block = undefined
    }
  }
  // A block never closed runs to the end, as Markdown draws it.
  if (block !== undefined) out.push({ text: block.text, fence: { open: block.open, close: block.marker } })
  if (prose.length > 0) out.push({ text: prose })

  return out
}

/**
 * Cuts a code block too long for one chunk at line breaks, and closes and reopens
 * the fence around each part so every part still draws as code. The first part is
 * sized to `firstRoom`, what is left of the chunk it joins, so the label above the
 * block stays with the start of it.
 */
const blockPieces = (text: string, { open, close }: Fence, max: number, firstRoom: number): string[] => {
  // The fence lines and their three line breaks come out of every part's room.
  const overhead = open.length + close.length + 3
  const room = max - overhead
  if (room <= 0) return prosePieces(text, max)
  const lines = text.split(/(?<=\n)/).slice(1)
  if (lines.length > 0 && closesFence(close, lines.at(-1)!)) lines.pop()

  const parts: string[] = []
  let rest = lines.join('')
  // Too little left to be worth filling: start the block on a fresh chunk.
  let budget = firstRoom - overhead >= max / 10 ? firstRoom - overhead : room
  while (rest.length > 0) {
    let [head = ''] = cut(rest, budget, /\n/g)
    if (head.length === budget && !head.includes('\n')) [head = ''] = cut(rest, budget, / /g)
    parts.push(open + '\n' + head.replace(/\n$/, '') + '\n' + close + '\n')
    rest = rest.slice(head.length)
    budget = room
  }

  return parts
}

/**
 * Packs paragraphs into chunks of at most `max` chars. A paragraph longer than
 * that is cut at line breaks, then at spaces, then anywhere. A fenced code block
 * is never cut while it fits in one chunk; a longer one is cut at line breaks
 * with its fence repeated on each part.
 */
export const chunkText = (text: string, max = CHUNK_CHARS): string[] => {
  const chunks: string[] = []
  let current = ''
  const add = (piece: string) => {
    if (current.length + piece.length > max && current.length > 0) {
      chunks.push(current)
      current = ''
    }
    current += piece
  }
  for (const s of segments(text)) {
    if (s.fence === undefined) prosePieces(s.text, max).forEach(add)
    else if (s.text.length <= max) add(s.text)
    else blockPieces(s.text, s.fence, max, max - current.length).forEach(add)
  }
  if (current.length > 0) chunks.push(current)

  // Blank lines are dropped from both ends; the first line keeps its indent.
  return chunks.map(c => c.replace(/^(\s*\n)+/, '').replace(/\s+$/, '')).filter(c => c.length > 0)
}

/**
 * Wraps raw text in a code fence one backtick longer than any run inside it, so
 * Markdown draws it as written: line breaks, indents and backticks kept.
 */
export const fenced = (text: string, language = ''): string => {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map(run => run.length))
  const fence = '`'.repeat(Math.max(3, longest + 1))

  return fence + language + '\n' + text + '\n' + fence
}

/**
 * A message flattened to text: its prose as written, then each tool call's input
 * and each tool result, fenced as code since they aren't Markdown.
 */
export const messageText = (m: SessionMessage): string => {
  const parts: string[] = []
  if (m.text) parts.push(m.text)
  for (const use of m.toolUses)
    parts.push('[tool: ' + use.tool + ']\n' + fenced(JSON.stringify(use.input, null, 2), 'json'))
  for (const res of m.toolResults ?? [])
    parts.push('[result' + (res.isError ? ' (error)' : '') + ']\n' + fenced(res.text))

  return parts.join('\n\n')
}

export const chunkMessages = (messages: readonly SessionMessage[]): Chunk[] =>
  messages.flatMap((message, m) => {
    const texts = chunkText(messageText(message))

    return texts.map((text, i) => ({ m, role: message.role, i, n: texts.length, text }))
  })
