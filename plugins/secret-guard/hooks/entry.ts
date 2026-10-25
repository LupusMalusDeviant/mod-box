// Entry of the standalone Secret Guard: the Mod Box code, registered on its own.
import type { Register } from 'claude-code'

import { register as inner } from '../mods/secret-guard/hooks/register'

export const register: Register = (on, options) => {
  ;(inner as any)(on, options)
}
