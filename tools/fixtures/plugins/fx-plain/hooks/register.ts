// Fixture plain: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fx-plain', description: 'fx-plain (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'fx-plain' }, async () => ({ text: String(options.greeting) }))
}
