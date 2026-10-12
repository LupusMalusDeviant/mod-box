// Fixture store: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.store.set('deadline', 42)
    await $.store.set(`guard`, 'x')
    return next(e)
  })
}
