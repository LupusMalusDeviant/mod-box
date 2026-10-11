import { describe, expect, test } from 'claude-code/testing'

import { cheaperModel, rankOf } from '../mods/subagent-saver/hooks/register'

const explore = { subagentType: 'Explore', parentModel: 'claude-opus-5-5', fork: false, provider: { plugin: 'engine' } }

describe('Subagent saver', () => {
  test('ranks models from cheap to expensive', () => {
    expect(rankOf('haiku')).toBeLessThan(rankOf('sonnet'))
    expect(rankOf('claude-sonnet-5-5')).toBeLessThan(rankOf('claude-opus-5-5'))
    expect(rankOf('something-else')).toBe(-1)
  })

  test('routes a built-in Explore agent without a model to the cheaper one', () => {
    expect(cheaperModel(explore, 'sonnet', ['Explore'])).toBe('sonnet')
    expect(cheaperModel(explore, 'haiku', ['Explore'])).toBe('haiku')
  })

  test('leaves everything else alone', () => {
    expect(cheaperModel({ ...explore, model: 'opus' }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel({ ...explore, fork: true }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel({ ...explore, isTeammate: true }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel({ ...explore, workflow: { runId: 'wf_1' } }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel({ ...explore, provider: { plugin: 'some-plugin' } }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel({ ...explore, subagentType: 'general-purpose' }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel({ ...explore, parentModel: 'claude-sonnet-5-5' }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel({ ...explore, parentModel: 'custom-model' }, 'sonnet', ['Explore'])).toBe(null)
    expect(cheaperModel(explore, 'off', ['Explore'])).toBe(null)
  })
})
