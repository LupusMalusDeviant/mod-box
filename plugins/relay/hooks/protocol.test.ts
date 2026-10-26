import { test, expect } from 'claude-code/testing'
import { extractSection, ownershipDenial, parsePacket, renderPacket, stripPacket, toList } from './protocol.ts'

const answer = [
  '## Ingest',
  'Read 3 links.',
  '### Details',
  'Link A covers X.',
  '## Schema',
  'Added tags.',
  '```relay',
  JSON.stringify({
    status: 'done',
    summary: 'Ingested 3 links.',
    decisions: ['Tags are lowercase'],
    facts: ['Link A: v2.1'],
    artifacts: [{ path: 'wiki/a.md', change: 'created' }],
    sections: ['Ingest', 'Schema'],
  }),
  '```',
].join('\n')

test('parses the last relay block and fills missing fields', async () => {
  const p = parsePacket(answer)!
  expect(p.status).toBe('done')
  expect(p.decisions).toEqual(['Tags are lowercase'])
  expect(p.facts).toEqual([{ id: 'F1', text: 'Link A: v2.1' }])
  expect(p.risks).toEqual([])
})

test('returns undefined without a packet', async () => {
  expect(parsePacket('just prose')).toBe(undefined)
})

test('strips the packet and extracts a section with its subsections', async () => {
  expect(stripPacket(answer).includes('```relay')).toBe(false)
  expect(extractSection(answer, 'ingest')).toBe('## Ingest\nRead 3 links.\n### Details\nLink A covers X.')
})

test('renders every essential field', async () => {
  const text = renderPacket('[relay] ingester · run 1', parsePacket(answer)!, '.relay/ingester/001.full.md')
  expect(text.includes('Tags are lowercase')).toBe(true)
  expect(text.includes('wiki/a.md (created)')).toBe(true)
  expect(text.includes('sections: Ingest | Schema')).toBe(true)
})

test('ownership: owned, foreign, outside and escaping paths', async () => {
  const cwd = 'C:\\proj'
  const owns = ['wiki/sources/']
  expect(ownershipDenial('wiki/sources/a.md', cwd, owns)).toBe(undefined)
  expect(ownershipDenial('C:\\proj\\wiki\\sources\\b.md', cwd, owns)).toBe(undefined)
  expect(ownershipDenial('C:/PROJ/wiki/sources/c.md', cwd, owns)).toBe(undefined)
  expect(ownershipDenial('wiki/_schema/x.md', cwd, owns)?.includes('not owned')).toBe(true)
  expect(ownershipDenial('wiki/sources/../_schema/x.md', cwd, owns)?.includes('..')).toBe(true)
  expect(ownershipDenial('D:/other/x.md', cwd, owns)?.includes('outside')).toBe(true)
  expect(ownershipDenial('anything.md', cwd, [])).toBe(undefined)
})

test('lean packets hold back facts and risks but keep what needs action', async () => {
  const text = renderPacket('[relay] r · run 1', parsePacket(answer)!, 'x.md', 'lean')
  expect(text.includes('Link A: v2.1')).toBe(false)
  expect(text.includes('Held back: 1 facts')).toBe(true)
  expect(text.includes('Tags are lowercase')).toBe(true)
})

test('toList splits strings and keeps list items whole', async () => {
  expect(toList('Read, Bash(git status:*)\nGrep')).toEqual(['Read', 'Bash(git status:*)', 'Grep'])
  expect(toList(['Bash(git push origin main)'])).toEqual(['Bash(git push origin main)'])
  expect(toList(undefined)).toEqual([])
})
