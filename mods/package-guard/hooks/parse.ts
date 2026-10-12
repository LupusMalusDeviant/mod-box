// Package Guard: which packages a shell command would install or run, per ecosystem. No $ here.

export type Ecosystem = 'npm' | 'pypi' | 'crates'
export type Wanted = { eco: Ecosystem; name: string; runs: boolean }

// Shell words of one command, quotes respected; good enough for install lines.
function words(cmd: string): string[] {
  const out: string[] = []
  let w: string | null = null
  let q = ''
  for (const ch of cmd) {
    if (q) {
      if (ch === q) q = ''
      else w = (w ?? '') + ch
    } else if (ch === '"' || ch === "'") {
      q = ch
      w ??= ''
    } else if (/\s/.test(ch)) {
      if (w !== null) out.push(w)
      w = null
    } else w = (w ?? '') + ch
  }
  if (w !== null) out.push(w)
  return out
}

// Flags that take a value: their value is no package name.
const VALUE_FLAGS = new Set([
  '--registry', '--prefix', '--tag', '--workspace', '-w', '--filter', '--cwd', '--dir', '-C',
  '-r', '--requirement', '-c', '--constraint', '-i', '--index-url', '--extra-index-url', '-t', '--target', '-e', '--editable', '--python', '-p', '--group', '--extra',
  '--git', '--branch', '--tag', '--rev', '--path', '--root', '--features', '-F', '--registry', '--package', '--manifest-path',
])

const isLocal = (a: string) => /^(\.{0,2}[\\/]|[a-z]:[\\/]|~[\\/]|file:|git\+|git:|https?:|github:|link:|workspace:)/i.test(a) || /\.(tgz|tar\.gz|whl|zip)$/i.test(a)

function args(list: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < list.length; i++) {
    const a = list[i] ?? ''
    if (a.startsWith('-')) {
      if (!a.includes('=') && VALUE_FLAGS.has(a)) i++
      continue
    }
    if (!isLocal(a)) out.push(a)
  }
  return out
}

/** npm-style names: drop a version or tag (`name@1.2`, `@scope/name@latest`). */
export function npmName(spec: string): string {
  const at = spec.indexOf('@', spec.startsWith('@') ? 1 : 0)
  return (at > 0 ? spec.slice(0, at) : spec).toLowerCase()
}

/** PyPI names: drop extras and version specifiers, normalised as PyPI does (PEP 503). */
export function pypiName(spec: string): string {
  return spec.replace(/\[.*?\]/g, '').split(/[<>=!~;@ ]/)[0]!.toLowerCase().replace(/[-_.]+/g, '-')
}

export function crateName(spec: string): string {
  return spec.split('@')[0]!.toLowerCase()
}

/** The packages one shell command line would install (or run, for npx and the like). */
export function wantedPackages(command: string): Wanted[] {
  const out: Wanted[] = []
  for (const part of command.split(/&&|\|\||;|\||\n/)) {
    const w = words(part.trim())
    // leading environment assignments and sudo
    while (w.length && (/^\w+=/.test(w[0]!) || w[0] === 'sudo')) w.shift()
    const [a, b, c] = w.map(x => x.toLowerCase())
    if (!a) continue
    const add = (eco: Ecosystem, names: string[], runs = false) => {
      for (const n of names) {
        const name = eco === 'npm' ? npmName(n) : eco === 'pypi' ? pypiName(n) : crateName(n)
        if (name) out.push({ eco, name, runs })
      }
    }
    if ((a === 'npm' || a === 'pnpm' || a === 'yarn' || a === 'bun') && ['i', 'install', 'add'].includes(b ?? '')) {
      add('npm', args(w.slice(2)))
    } else if (a === 'npx' || a === 'pnpx' || a === 'bunx' || ((a === 'pnpm' || a === 'yarn') && b === 'dlx')) {
      const rest = args(w.slice(a === 'npx' || a === 'pnpx' || a === 'bunx' ? 1 : 2))
      // only the first word is the package; what follows are its arguments
      if (rest[0]) add('npm', [rest[0]], true)
    } else if ((a === 'pip' || a === 'pip3') && b === 'install') {
      add('pypi', args(w.slice(2)))
    } else if ((a === 'python' || a === 'python3' || a === 'py') && b === '-m' && c === 'pip' && w[3]?.toLowerCase() === 'install') {
      add('pypi', args(w.slice(4)))
    } else if (a === 'uv' && b === 'pip' && c === 'install') {
      add('pypi', args(w.slice(3)))
    } else if ((a === 'uv' || a === 'poetry') && b === 'add') {
      add('pypi', args(w.slice(2)))
    } else if (a === 'pipx' && (b === 'install' || b === 'run')) {
      add('pypi', b === 'run' ? args(w.slice(2)).slice(0, 1) : args(w.slice(2)), b === 'run')
    } else if (a === 'uvx') {
      add('pypi', args(w.slice(1)).slice(0, 1), true)
    } else if (a === 'cargo' && (b === 'add' || b === 'install')) {
      add('crates', args(w.slice(2)))
    }
  }
  // the same package once
  const seen = new Set<string>()
  return out.filter(p => {
    const k = `${p.eco}:${p.name}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}
