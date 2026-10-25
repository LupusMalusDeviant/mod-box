// Entry of the standalone Handoff Note. The mod hands its display to a band (in the Mod Box the
// band manager draws it); here this hook, registered first and so the outermost, draws it below
// whatever else is above the prompt.
import type { Register } from 'claude-code'

import { register as inner } from '../mods/handoff/hooks/register'
import { openBand, takeBand } from '../mods/settings/hooks/band'

export const register: Register = (on, options) => {
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    openBand(e)
    const rest = await next(e)
    const parts = takeBand(e)
    if (e.props.hasSurvey || parts.length === 0) return rest
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {rest}
        {parts.map(p => (
          <Box key={`band-${p.id}`} flexDirection="row" paddingX={1}>
            <Box flexShrink={1}>{p.line as any}</Box>
            {(p.actions as any[]).flatMap((a, i) => [<Text key={`gap-${i}`}>{'  '}</Text>, a])}
          </Box>
        ))}
      </Box>
    )
  })
  ;(inner as any)(on, options)
}
