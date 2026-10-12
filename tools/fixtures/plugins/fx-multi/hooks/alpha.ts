// Fixture alpha: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fx-alpha', description: 'fx-alpha (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'fx-alpha' }, async () => ({ text: `alpha count=${typeof options.count}:${String(options.count)}` }))
}
