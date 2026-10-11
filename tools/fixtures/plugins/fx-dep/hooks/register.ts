// Fixture dep: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fx-dep', description: 'fx-dep (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'fx-dep' }, async () => ({ text: 'dep' }))
}
