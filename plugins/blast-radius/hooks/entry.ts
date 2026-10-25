// Entry of the standalone Blast Radius: the Mod Box code, registered on its own.
import type { Register } from 'claude-code'

import { register as inner } from '../mods/blast-radius/hooks/blast-radius.mjs'

export const register: Register = (on, options) => {
  ;(inner as any)(on, options)
}
