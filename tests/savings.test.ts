import { describe, expect, test } from 'claude-code/testing'

import { autoCompactTokens, sparkline, trendText } from '../mods/cache-meter/hooks/register'
import { compactHint } from '../mods/cache-tax/hooks/register'

describe('Context trend', () => {
  test('one bar per turn on a fixed scale; growth and turns left', () => {
    expect(sparkline([0, 12.5, 50, 99, 100])).toBe('▁▂▅██')
    expect(trendText([10, 20])).toBe('')
    expect(trendText([10, 20, 30])).toBe('· +10.0%/turn, full in ~7')
    expect(trendText([30, 30.2, 30.4])).toBe('· steady')
    // a compact (drop) does not count as growth
    expect(trendText([60, 70, 20, 30])).toBe('· +10.0%/turn, full in ~7')
  })
})

describe('Compaction', () => {
  test('the cold-send guard offers compacting first, with numbers', () => {
    const hint = compactHint(300000, 'claude-opus-5-5')
    expect(hint).toMatch(/\/compact first/)
    expect(hint).toMatch(/instead of 300k tokens/)
    expect(compactHint(30000, 'claude-opus-5-5')).toBe('')
    expect(compactHint(300000, 'unknown-model')).toBe('')
  })

  test('auto-compact window choices map to Claude Code tokens', () => {
    expect(autoCompactTokens('auto')).toBe(null)
    expect(autoCompactTokens('200k')).toBe(200000)
    expect(autoCompactTokens('500k')).toBe(500000)
    expect(autoCompactTokens('50k')).toBe(null)
  })
})
