// Fixture assets: a tiny function-hook module.
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'fx-assets', description: 'fx-assets (fixture)' })
    return next(e)
  })
  on('command.run', { command: 'fx-assets' }, async ($) => {
    const text = String(await $.fs.read(`${$.plugin.root}/media/hello.txt`).catch(() => 'missing'))
    const help = String(await $.fs.read($.plugin.root + '/docs/help.txt').catch(() => 'missing'))
    await $.audio.play({ asset: 'media/ding.wav' }).catch(() => {})
    return { text: text.trim() + '|' + help.trim() }
  })
}
