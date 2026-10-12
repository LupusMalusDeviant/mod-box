// Fixture required: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fx-required', description: 'fx-required (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'fx-required' }, async () => ({ text: String(options.endpoint ?? 'none') }))
}
