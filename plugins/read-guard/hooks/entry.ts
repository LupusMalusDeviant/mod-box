// Entry of the standalone Read Guard: the Mod Box code, registered on its own.
import type { Register } from 'claude-code'

import { register as inner } from '../mods/read-guard/hooks/register'

export const register: Register = (on, options) => {
  ;(inner as any)(on, options)
}
