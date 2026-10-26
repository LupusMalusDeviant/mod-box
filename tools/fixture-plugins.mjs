// The fixture plugins in tools/fixtures/plugins keep their manifests in `claude-plugin/` (no dot),
// so mod indexes that crawl GitHub for `.claude-plugin/plugin.json` do not list them as real mods.
// fixturePlugins() copies them to a folder of the caller's and restores the real layout there.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'plugins')

/** Copies the fixture plugins (and their marketplace) to `to` with `.claude-plugin/` folders; returns `to`. */
export function fixturePlugins(to) {
  fs.cpSync(SRC, to, { recursive: true })
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      const p = path.join(dir, e.name)
      if (e.name === 'claude-plugin') fs.renameSync(p, path.join(dir, '.claude-plugin'))
      else walk(p)
    }
  }
  walk(to)
  return to
}
