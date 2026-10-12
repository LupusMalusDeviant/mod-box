// Fixture beta: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fx-beta', description: 'fx-beta (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'fx-beta' }, async () => ({ text: `beta loud=${typeof options.loud}:${String(options.loud)}` }))
}
