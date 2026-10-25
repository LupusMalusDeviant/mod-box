// Screen Mask: while you share your screen, the transcript hides API keys, tokens, private keys,
// e-mail addresses, IP addresses, your login name in paths and any names you list. Only the
// drawing changes: Claude still reads and writes the original text. Nothing leaves the machine.
// /mask switches it; the band shows when it is on.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { offer as offerBand } from '../../settings/hooks/band'
import type { BandPart } from '../../settings/hooks/band'
import { type MaskRules, maskDeep, maskText, parseTerms } from './mask'

const isOn = atom({ plugin: 'screen-mask', key: 'on' } as const, false)
// Kept across sessions: a restart in the middle of a screen share must not uncover anything.
const STORE_ON = 'sm:on'

let lang: 'de' | 'en' = 'en'
const t = (de: string, en: string) => (lang === 'en' ? en : de)
const rules: MaskRules = { terms: [], user: '', emails: true, ips: true }

const mask = (s: string) => maskText(s, rules)

async function setOn($: EngineInterface, on: boolean) {
  await update($, isOn, () => on)
  await $.store.set(STORE_ON, on).catch(() => {})
  $.ui.toast(on ? t('🙈 Bildschirmschutz an: Geheimnisse und Namen sind in der Anzeige verdeckt.', '🙈 Screen mask on: secrets and names are hidden on screen.') : t('Bildschirmschutz aus.', 'Screen mask off.'))
}

export const register: Register = (on, options) => {
  lang = options.language === 'de' ? 'de' : 'en'
  rules.terms = parseTerms(String(options.terms ?? ''))
  rules.emails = String(options.emails ?? 'on') !== 'off'
  rules.ips = String(options.ips ?? 'on') !== 'off'

  on('session.start', {}, async ($, e, next) => {
    const r = await next(e)
    rules.user = String((await $.env.get('USERNAME')) || (await $.env.get('USER')) || '')
    await $.command.register({ name: 'mask', description: t('Bildschirmschutz: Geheimnisse und Namen in der Anzeige verdecken', 'Screen mask: hide secrets and names on screen'), argumentHint: '[on|off]' })
    if ((await $.store.get(STORE_ON).catch(() => false)) === true) await update($, isOn, () => true)
    return r
  })

  on('command.run', { command: 'mask' }, async ($, e) => {
    const arg = String(e.args ?? '').trim().toLowerCase()
    const want = arg === 'on' || arg === 'an' ? true : arg === 'off' || arg === 'aus' ? false : !(await read($, isOn))
    await setOn($, want)
    return { text: want ? t('Bildschirmschutz an.', 'Screen mask on.') : t('Bildschirmschutz aus.', 'Screen mask off.') }
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    return next({ ...e, props: { ...e.props, text: mask(e.props.text) } })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    return next({ ...e, props: { ...e.props, text: mask(e.props.text) } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const props = e.props as Record<string, unknown>
    return next({ ...e, props: { ...e.props, input: maskDeep(props.input, mask), ...(props.output === undefined ? {} : { output: maskDeep(props.output, mask) }) } } as typeof e)
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    const props = e.props as Record<string, unknown>
    return next({ ...e, props: { ...e.props, output: maskDeep(props.output, mask) } } as typeof e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    if (!(await read($, isOn))) return next(e)
    return next({ ...e, props: { ...e.props, calls: e.props.calls.map(c => ({ ...c, input: maskDeep((c as Record<string, unknown>).input, mask) })) } } as typeof e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rest = await next(e)
    if (!e.props.hasSurvey) {
      const part = await band($, e).catch(() => null)
      if (part) offerBand(e, part)
    }
    return rest
  })
}

export async function band($: EngineInterface, e: any): Promise<BandPart | null> {
  if (!(await read($, isOn))) return null
  const { Text, Button } = $.ui.resolve(e)
  const what = [t('Geheimnisse', 'secrets'), rules.emails ? t('E-Mails', 'e-mails') : '', rules.ips ? 'IPs' : '', rules.user ? t('Benutzername', 'login name') : '', rules.terms.length ? t(`${rules.terms.length} Begriffe`, `${rules.terms.length} terms`) : ''].filter(Boolean).join(', ')
  return {
    id: 'screenMask',
    urgent: false,
    short: <Text color="yellow">🙈</Text>,
    line: (
      <Text>
        <Text color="yellow" bold>{'🙈 '}</Text>
        <Text>{t('Bildschirmschutz an: ', 'Screen mask on: ')}</Text>
        <Text dimColor>{what}</Text>
      </Text>
    ),
    actions: [<Button key="sm-off" label={t('Aus', 'Off')} plain onPress={() => void setOn($, false)} />],
    status: `🙈 ${t('Bildschirmschutz', 'Screen mask')}`,
  }
}
