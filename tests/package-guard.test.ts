import { describe, expect, mock, test } from 'claude-code/testing'

import { npmName, pypiName, wantedPackages } from '../mods/package-guard/hooks/parse'
import { reasonsFor } from '../mods/package-guard/hooks/register'
import { distance, lookalike } from '../mods/package-guard/hooks/similar'

const QUIET = { language: 'en', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false }
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
const NOW = Date.parse('2026-10-12T00:00:00Z')
const OLD = '2015-01-01T00:00:00Z'

// What the registry script answers in the tests, per "<eco> <name>".
const REGISTRY: Record<string, object> = {
  'npm react': { exists: true, created: OLD, versions: 2900, latest: '19.0.0', repo: null },
  'npm reakt-hooks-x': { exists: false },
  'npm lodahs': { exists: true, created: '2019-11-25T00:00:00Z', versions: 1, latest: '0.0.1-security', repo: 'git+https://github.com/npm/security-holder.git' },
}

function engine(on: any) {
  mock.clock(on)
  mock.store(on)
  const ran: string[] = []
  const asked: string[] = []
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 's' }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'below' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', () => ({ value: undefined }))
  on('process.run', (_$: any, e: any) => {
    const argv = [...e.argv] as string[]
    if (argv[0] === 'node' && /registry\.mjs$/.test(argv[1] ?? '')) {
      const key = `${argv[2]} ${argv[3]}`
      asked.push(key)
      return ok(JSON.stringify(REGISTRY[key] ?? { exists: true, created: null, versions: 50, latest: '1.0.0', repo: null }) + '\n')
    }
    return ok()
  })
  on('tool.call', (_$: any, e: any) => {
    ran.push(`${e.tool}:${e.command ?? ''}`)
    return { result: 'ok', text: 'ok' }
  })
  return { ran, asked }
}

describe('Package guard: reading commands', () => {
  test('finds packages per ecosystem', () => {
    expect(wantedPackages('npm install react@18 -D @types/node')).toEqual([
      { eco: 'npm', name: 'react', runs: false },
      { eco: 'npm', name: '@types/node', runs: false },
    ])
    expect(wantedPackages('cd app && pnpm add zod --filter web')).toEqual([{ eco: 'npm', name: 'zod', runs: false }])
    expect(wantedPackages('npx create-vite@latest my-app --template react')).toEqual([{ eco: 'npm', name: 'create-vite', runs: true }])
    expect(wantedPackages('python -m pip install "requests[socks]>=2" -r req.txt')).toEqual([{ eco: 'pypi', name: 'requests', runs: false }])
    expect(wantedPackages('uv add Python_Dotenv')).toEqual([{ eco: 'pypi', name: 'python-dotenv', runs: false }])
    expect(wantedPackages('cargo add serde --features derive')).toEqual([{ eco: 'crates', name: 'serde', runs: false }])
  })

  test('ignores everything that is no registry install', () => {
    expect(wantedPackages('npm install')).toEqual([])
    expect(wantedPackages('npm ci && npm test')).toEqual([])
    expect(wantedPackages('pip install -e . ./dist/x.whl')).toEqual([])
    expect(wantedPackages('npm i github:user/repo ../local')).toEqual([])
    expect(wantedPackages('echo npm install react')).toEqual([])
    expect(wantedPackages('git status')).toEqual([])
  })

  test('normalises names', () => {
    expect(npmName('@scope/pkg@1.2.3')).toBe('@scope/pkg')
    expect(npmName('Lodash@latest')).toBe('lodash')
    expect(pypiName('Django_REST.framework==3.0')).toBe('django-rest-framework')
  })
})

describe('Package guard: look-alikes and reasons', () => {
  test('edit distance counts a swap as one', () => {
    expect(distance('lodash', 'lodahs')).toBe(1)
    expect(distance('react', 'react')).toBe(0)
  })

  test('finds typosquats, not the real names or unrelated ones', () => {
    expect(lookalike('npm', 'lodahs')).toBe('lodash')
    expect(lookalike('npm', 'expres')).toBe('express')
    expect(lookalike('npm', 'reactdom')).toBe('react-dom')
    expect(lookalike('pypi', 'reqeusts')).toBe('requests')
    expect(lookalike('crates', 'serde-json')).toBe('serde_json')
    expect(lookalike('npm', 'lodash')).toBe(null)
    expect(lookalike('npm', 'left-pad')).toBe(null)
    // short names are too close to everything
    expect(lookalike('npm', 'wx')).toBe(null)
  })

  test('reasons', () => {
    expect(reasonsFor('npm', 'react', { exists: true, created: OLD, versions: 2900 }, NOW)).toEqual([])
    expect(reasonsFor('npm', 'made-up-thing', { exists: false }, NOW)[0]).toContain('does not exist')
    expect(reasonsFor('npm', 'fresh-lib', { exists: true, created: '2026-10-10T00:00:00Z', versions: 1 }, NOW)[0]).toContain('2 day(s) old')
    expect(reasonsFor('npm', 'expres', { exists: true, created: '2026-06-01T00:00:00Z', versions: 2 }, NOW)[0]).toContain('looks like "express"')
    // an old, well-used look-alike is a real package of its own
    expect(reasonsFor('npm', 'expres', { exists: true, created: OLD, versions: 40 }, NOW)).toEqual([])
    expect(reasonsFor('npm', 'lodahs', { exists: true, latest: '0.0.1-security', versions: 1 }, NOW)[0]).toContain('security placeholder')
    // without an answer only a look-alike is worth mentioning
    expect(reasonsFor('npm', 'fresh-lib', null, NOW)).toEqual([])
    expect(reasonsFor('npm', 'lodahs', { error: 'offline' }, NOW)[0]).toContain('not reachable')
  })
})

describe('Package guard: in the session', () => {
  test('holds a made-up package, lets a known one through', { options: QUIET }, async ($: any, on: any) => {
    const { ran, asked } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const bad = await $.tool.call({ tool: 'Bash', command: 'npm install reakt-hooks-x' })
    expect(bad.deny).toContain('reakt-hooks-x')
    expect(bad.deny).toContain('does not exist')
    const good = await $.tool.call({ tool: 'Bash', command: 'npm install react' })
    expect(good.deny).toBeUndefined()
    expect(ran).toEqual(['Bash:npm install react'])
    expect(asked).toEqual(['npm reakt-hooks-x', 'npm react'])
  })

  test('/pkg-allow lets the held package through', { options: QUIET }, async ($: any, on: any) => {
    const { ran } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    expect((await $.tool.call({ tool: 'Bash', command: 'npm i lodahs' })).deny).toContain('security placeholder')
    const r = await $.command.run({ command: 'pkg-allow', args: 'lodahs' })
    expect(r.text).toContain('lodahs')
    expect((await $.tool.call({ tool: 'Bash', command: 'npm i lodahs' })).deny).toBeUndefined()
    expect(ran).toEqual(['Bash:npm i lodahs'])
  })

  test('warn mode only warns', { options: { ...QUIET, packageMode: 'warn' } }, async ($: any, on: any) => {
    const { ran } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    expect((await $.tool.call({ tool: 'Bash', command: 'npm install reakt-hooks-x' })).deny).toBeUndefined()
    expect(ran).toHaveLength(1)
  })

  test('when off it asks nobody', { options: { ...QUIET, packageGuard: false } }, async ($: any, on: any) => {
    const { asked } = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    expect((await $.tool.call({ tool: 'Bash', command: 'npm install reakt-hooks-x' })).deny).toBeUndefined()
    expect(asked).toEqual([])
  })
})
