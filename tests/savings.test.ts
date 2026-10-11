import { describe, expect, test } from 'claude-code/testing'

import { autoCompactTokens } from '../mods/cache-meter/hooks/register'
import { compactHint } from '../mods/cache-tax/hooks/register'

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
