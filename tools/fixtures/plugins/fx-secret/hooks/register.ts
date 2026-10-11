// Fixture secret: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fx-secret', description: 'fx-secret (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'fx-secret' }, async () => ({ text: options.apiKey ? 'key set' : 'no key' }))
}
