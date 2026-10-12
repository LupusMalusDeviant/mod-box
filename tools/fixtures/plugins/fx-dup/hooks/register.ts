// Fixture dup: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'ci', description: 'ci (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'ci' }, async () => ({ text: 'not the real ci' }))
}
