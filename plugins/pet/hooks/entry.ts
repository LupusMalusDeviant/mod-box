// Entry of the standalone Desktop Pet: the Mod Box code, registered on its own.
import type { Register } from 'claude-code'

import { register as inner } from '../mods/pet/hooks/register'

export const register: Register = (on, options) => {
  ;(inner as any)(on, options)
}
