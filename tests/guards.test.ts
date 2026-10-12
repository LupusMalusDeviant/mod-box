import { describe, expect, mock, test } from 'claude-code/testing'

import { mergeText, parseChecks, PR_CREATE, PR_URL, PUSH, summary } from '../mods/ci-watch/hooks/register'
import { findSecrets, gitAddPaths, globMatch, isPlaceholder, isSecretFile, parseAllow, secretsInDiff, sha256 } from '../mods/secret-guard/hooks/register'
import { BUILD } from '../mods/sign-guard/hooks/register'

const KEY = 'sk-ant-api03-' + 'a1B2c3D4e5F6g7H8i9J0'.repeat(3)
// Filetree and Savvy Progress react to every tool call with timers that would still fire
// after the test; they are off for the guard tests.
const QUIET = { language: 'de', filetree: false, savvyProgress: false, replayTheater: false, cacheMeter: false }
const wait = (ms = 20) => new Promise(done => (globalThis as any).setTimeout(done, ms))
const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })

type Proc = (argv: string[]) => { value: unknown } | undefined

function engine(on: any, proc: Proc = () => undefined, toolText = 'ok') {
  mock.clock(on)
  mock.store(on)
  const ran: string[] = []
  const filled: string[] = []
  ;(ran as any).filled = filled
  on('command.register', () => ({ value: {} }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('prompt.fill', (_$: any, e: any) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  on('fs.exists', () => ({ value: false }))
  on('session.id', () => ({ value: 's' }))
  on('ui.render', ($: any, e: any) => $.ui.resolve(e).Text({ children: 'unten' }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/repo' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'OS' ? 'Linux' : undefined }))
  on('process.run', (_$: any, e: any) => proc([...e.argv]) ?? ok())
  on('tool.call', (_$: any, e: any) => {
    ran.push(`${e.tool}:${e.command ?? e.file_path ?? ''}`)
    return { result: toolText, text: toolText }
  })
  return ran
}

describe('Secret guard', () => {
  test('detects keys, files and git add', () => {
    expect(findSecrets(`const k = "${KEY}"`, 'a.ts').map(h => h.what)).toContain('Anthropic-API-Key')
    expect(findSecrets('api_key = "your_api_key_here_please_change"', 'a.ts')).toEqual([])
    expect(findSecrets(['-'.repeat(5) + 'BEGIN', 'OPENSSH', 'PRIVATE', 'KEY' + '-'.repeat(5)].join(' '), 'k')).toHaveLength(1)
    expect(isSecretFile('/repo/.env')).toBe(true)
    expect(isSecretFile('/repo/.env.example')).toBe(false)
    expect(isSecretFile('certs/server.pem')).toBe(true)
    expect(isSecretFile('src/env.ts')).toBe(false)
    expect(gitAddPaths('git add src/a.ts .env')).toEqual(['src/a.ts', '.env'])
    expect(gitAddPaths('git add -A')).toBe('all')
    expect(gitAddPaths('git status')).toBe(null)
  })

  test('stops Write with an API key, lets normal writes through', { options: QUIET }, async ($: any, on: any) => {
    const ran = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const bad = await $.tool.call({ tool: 'Write', file_path: '/repo/src/config.ts', content: `export const KEY = "${KEY}"` })
    expect(bad.deny).toContain('Anthropic-API-Key')
    const good = await $.tool.call({ tool: 'Write', file_path: '/repo/src/config.ts', content: 'export const KEY = process.env.KEY' })
    expect(good.deny).toBeUndefined()
    expect(ran).toEqual(['Write:/repo/src/config.ts'])
  })

  test('stops git add .env', { options: QUIET }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const r = await $.tool.call({ tool: 'Bash', command: 'git add .env && git commit -m x' })
    expect(r.deny).toContain('.env')
  })

  test('warn mode lets it through', { options: { ...QUIET, secretMode: 'warn' } }, async ($: any, on: any) => {
    const ran = engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const r = await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: KEY })
    expect(r.deny).toBeUndefined()
    expect(ran).toHaveLength(1)
  })

  test('when off it checks nothing', { options: { ...QUIET, secretGuard: false } }, async ($: any, on: any) => {
    engine(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    const r = await $.tool.call({ tool: 'Write', file_path: '/repo/a.ts', content: KEY })
    expect(r.deny).toBeUndefined()
  })
})

describe('CI watch', () => {
  test('detects pushes', () => {
    expect(PUSH.test('git push')).toBe(true)
    expect(PUSH.test('cd app && git push origin main')).toBe(true)
    expect(PUSH.exec('git -C sub push')?.[1]).toBe('sub')
    expect(PUSH.test('git pushx')).toBe(false)
    expect(PUSH.test('echo "git"; npm run push')).toBe(false)
  })

  test('after a push: red with log in the band and an analysis request', { options: QUIET }, async ($: any, on: any) => {
    const ran = engine(on, argv => {
      const cmd = argv.join(' ')
      if (cmd === 'git rev-parse HEAD') return ok('abcdef1234567890\n')
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('main\n')
      if (cmd.startsWith('gh run list')) {
        return ok(JSON.stringify([
          { databaseId: 7, name: 'ci', workflowName: 'Build', status: 'completed', conclusion: 'success', url: 'u7' },
          { databaseId: 8, name: 'ci', workflowName: 'Tests', status: 'completed', conclusion: 'failure', url: 'u8' },
        ]))
      }
      if (cmd.startsWith('gh run view 8')) return ok('step 1\nError: expected 2, got 3\n')
      return undefined
    })
    const notes: string[] = []
    on('ui.notify', (_$: any, e: any) => {
      notes.push(`${e.options?.title ?? e.title ?? ''}: ${e.text}`)
      return { value: { isSent: true, channel: 'terminal' } }
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    await $.tool.call({ tool: 'Bash', command: 'git push origin main' })
    await wait(50)
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160 } })
    expect(await ui.find({ type: 'Text', text: /rot in Tests/ })).toBeDefined()
    expect(((ran as any).filled as string[]).join('\n')).toContain('gh run view 8 --log-failed')
    // red ends with a system notification (default: red only)
    expect(notes.join('\n')).toMatch(/Tests \(failure\)/)
  })

  test('summary', () => {
    const w = { sha: 'abcdef123', branch: 'main', cwd: '/', startedAt: 1_000, endedAt: 66_000, phase: 'gruen' as const, runs: [{ id: 1, name: 'B', status: 'completed', conclusion: 'success', url: '' }], failed: null, message: '', isDismissed: false }
    expect(summary(w)).toBe('main@abcdef1: green, 1 run(s) in 1m05s')
  })
})

describe('Sign guard', () => {
  test('detects Windows builds', () => {
    for (const c of ['cargo build --release', 'dotnet publish -c Release', 'go build -o app.exe .', 'pyinstaller main.spec', 'npm run tauri build', 'npx electron-builder --win', 'msbuild app.sln /p:Configuration=Release']) {
      expect(BUILD.test(c)).toBe(true)
    }
    for (const c of ['cargo build', 'cargo test --release', 'npm run dev', 'dotnet build']) expect(BUILD.test(c)).toBe(false)
  })
})


describe('Secret guard: exceptions', () => {
  test('gitignore-style path patterns', () => {
    expect(globMatch('tests/fixtures/**', 'tests/fixtures/a/key.ts')).toBe(true)
    expect(globMatch('tests/fixtures/**', 'src/tests/fixtures/key.ts')).toBe(false)
    expect(globMatch('fixtures', 'src/fixtures/key.ts')).toBe(true)
    expect(globMatch('*.example.ts', 'src/config.example.ts')).toBe(true)
    expect(globMatch('*.example.ts', 'src/config.ts')).toBe(false)
    expect(globMatch('/docs/*.md', 'docs/setup.md')).toBe(true)
    expect(globMatch('/docs/*.md', 'docs/sub/setup.md')).toBe(false)
    expect(globMatch('Tests/**', 'tests/x.ts', true)).toBe(true)
  })

  test('reads the list, detects placeholders, splits a diff by file', () => {
    const a = parseAllow(['# Kommentar', 'tests/**', 'sha256:' + 'ab'.repeat(32) + '  # Test-Schlüssel', '', 'sha256:kaputt'])
    expect(a.globs).toEqual(['tests/**', 'sha256:kaputt'])
    expect(a.hashes.has('ab'.repeat(32))).toBe(true)
    expect(isPlaceholder('some-EXAMPLE-value')).toBe(true)
    expect(isPlaceholder('token-xxxxxxxx')).toBe(true)
    expect(isPlaceholder('your_api_key')).toBe(true)
    expect(isPlaceholder(KEY)).toBe(false)
    const hits = secretsInDiff(['+++ b/tests/k.ts', '+const a = "' + KEY + '"', '+++ b/src/ok.ts', '+const b = 1'].join('\n'))
    expect(hits.map(h => h.path)).toEqual(['tests/k.ts'])
  })

  function guardEngine(on: any, files: Record<string, string> = {}, store: Record<string, unknown> = {}) {
    mock.clock(on)
    on('command.register', () => ({ value: {} }))
    on('ui.toast', () => ({ value: undefined }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
    on('session.id', () => ({ value: 's' }))
    on('session.cwd', () => ({ value: '/repo' }))
    on('session.usage', () => ({ value: { startedAt: 0, context: { window: 200_000 }, rateLimits: [] } }))
    on('env.get', () => ({ value: undefined }))
    on('fs.exists', () => ({ value: false }))
    on('fs.stat', (_$: any, e: any) => {
      const p = String(e.path).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
      return p in files ? { value: { kind: 'file', size: files[p]!.length, mtimeMs: 1, isLink: false } } : { deny: 'ENOENT' }
    })
    on('fs.read', (_$: any, e: any) => {
      const p = String(e.path).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
      return p in files ? { value: files[p] } : { deny: 'ENOENT' }
    })
    on('store.get', (_$: any, e: any) => ({ value: store[e.key] }))
    on('store.set', (_$: any, e: any) => {
      store[e.key] = e.value
      return { value: undefined }
    })
    on('store.delete', () => ({ value: undefined }))
    on('process.run', () => ({ value: { exitCode: 1, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
    on('tool.call', () => ({ result: 'ok', text: 'ok' }))
  }

  const start = ($: any) => $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })

  test('project exception by path lets the fixture through, nothing else', { options: QUIET }, async ($: any, on: any) => {
    guardEngine(on, { '/repo/.secretguard-allow': '# test\ntests/fixtures/**\n' })
    await start($)
    const ok = await $.tool.call({ tool: 'Write', file_path: '/repo/tests/fixtures/key.ts', content: `export const K = "${KEY}"` })
    expect(ok.deny).toBeUndefined()
    const bad = await $.tool.call({ tool: 'Write', file_path: '/repo/src/key.ts', content: `export const K = "${KEY}"` })
    expect(bad.deny).toContain('Anthropic-API-Key')
  })

  test('global exception by hash lets exactly this value through', { options: QUIET }, async ($: any, on: any) => {
    const hash = await sha256(KEY)
    guardEngine(on, {}, { 'secret-allow-global': [`sha256:${hash}  # Test-Schlüssel`] })
    await start($)
    const ok = await $.tool.call({ tool: 'Write', file_path: '/repo/src/a.ts', content: KEY })
    expect(ok.deny).toBeUndefined()
    const other = KEY.slice(0, -4) + 'zzzz'
    const bad = await $.tool.call({ tool: 'Write', file_path: '/repo/src/b.ts', content: other })
    expect(bad.deny).toContain('Anthropic-API-Key')
  })

  // A placeholder shaped like a key is assembled at runtime (like KEY above).
  const PLACEHOLDER = 'sk-ant-api03-' + 'EXAMPLE'.repeat(4)

  test('placeholders pass', { options: QUIET }, async ($: any, on: any) => {
    guardEngine(on)
    await start($)
    const r = await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: PLACEHOLDER })
    expect(r.deny).toBeUndefined()
  })

  test('without placeholder detection the placeholder is stopped too', { options: { ...QUIET, secretPlaceholders: 'off' } }, async ($: any, on: any) => {
    guardEngine(on)
    await start($)
    const r = await $.tool.call({ tool: 'Write', file_path: '/repo/README.md', content: PLACEHOLDER })
    expect(r.deny).toContain('Anthropic-API-Key')
  })

  test('Claude may not change the exception list, even in warn mode', { options: { ...QUIET, secretMode: 'warn' } }, async ($: any, on: any) => {
    guardEngine(on)
    await start($)
    const w = await $.tool.call({ tool: 'Write', file_path: '/repo/.secretguard-allow', content: '**\n' })
    expect(w.deny).toContain('only by the user')
    const b = await $.tool.call({ tool: 'Bash', command: 'echo "**" >> .secretguard-allow' })
    expect(b.deny).toContain('only by the user')
  })
})

describe('CI watch: pull requests', () => {
  test('evaluates checks, merge state, PR URL', () => {
    const runs = parseChecks(JSON.stringify([
      { name: 'build', workflow: 'CI', bucket: 'pass', link: 'https://github.com/o/r/actions/runs/123/job/9' },
      { name: 'Vercel', workflow: '', bucket: 'fail', link: 'https://vercel.com/o/r/abc' },
      { name: 'lint', workflow: 'CI', bucket: 'pending', link: 'https://github.com/o/r/actions/runs/124/job/1' },
    ]))
    expect(runs.map(r => [r.id, r.name, r.status, r.conclusion])).toEqual([
      [123, 'CI / build', 'completed', 'success'],
      [0, 'Vercel', 'completed', 'failure'],
      [124, 'CI / lint', 'in_progress', 'pending'],
    ])
    expect(mergeText({ state: 'OPEN', mergeStateStatus: 'CLEAN' })).toBe('ready to merge')
    expect(mergeText({ state: 'OPEN', reviewDecision: 'REVIEW_REQUIRED', mergeStateStatus: 'BLOCKED' })).toBe('waiting for review')
    expect(mergeText({ state: 'OPEN', isDraft: true })).toBe('still a draft')
    expect(mergeText({ state: 'MERGED' })).toBe('already merged')
    expect(PR_URL.exec('Creating pull request\nhttps://github.com/o/r/pull/42\n')?.[1]).toBe('42')
    expect(PR_CREATE.test('gh pr create --fill')).toBe(true)
    expect(PR_CREATE.test('gh pr view 3')).toBe(false)
  })

  const BAND_PROPS = { component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } }
  const PR = JSON.stringify({ number: 42, url: 'https://github.com/o/r/pull/42', title: 'Neue Funktion', headRefName: 'feature', headRefOid: 'abcdef1234', state: 'OPEN' })

  test('push to a branch with a PR: external check red, link instead of log', { options: { ...QUIET, bandLayout: 'lines' } }, async ($: any, on: any) => {
    const ran = engine(on, argv => {
      const cmd = argv.join(' ')
      if (cmd === 'git rev-parse HEAD') return ok('abcdef1234\n')
      if (cmd === 'git rev-parse --abbrev-ref HEAD') return ok('feature\n')
      if (cmd.startsWith('gh pr view feature')) return ok(PR)
      if (cmd.startsWith('gh pr checks 42')) {
        return { value: { exitCode: 1, stdout: JSON.stringify([
          { name: 'build', workflow: 'CI', bucket: 'pass', link: 'https://github.com/o/r/actions/runs/123/job/9' },
          { name: 'Vercel', workflow: '', bucket: 'fail', link: 'https://vercel.com/o/r/abc' },
        ]), stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
      }
      return undefined
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    await $.tool.call({ tool: 'Bash', command: 'git push' })
    await wait(50)
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', ...BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: /PR #42: rot in Vercel/ })).toBeDefined()
    const filled = ((ran as any).filled as string[]).join('\n')
    expect(filled).toContain('https://vercel.com/o/r/abc')
    expect(filled).not.toContain('gh run view')
  })

  test('after gh pr create: all checks green and ready to merge', { options: { ...QUIET, bandLayout: 'lines' } }, async ($: any, on: any) => {
    engine(
      on,
      argv => {
        const cmd = argv.join(' ')
        if (cmd.startsWith('gh pr view https://github.com/o/r/pull/42')) return ok(PR)
        if (cmd.startsWith('gh pr checks 42')) return ok(JSON.stringify([{ name: 'build', workflow: 'CI', bucket: 'pass', link: 'https://github.com/o/r/actions/runs/1/job/1' }]))
        if (cmd.startsWith('gh pr view 42')) return ok(JSON.stringify({ state: 'OPEN', mergeStateStatus: 'CLEAN', reviewDecision: '', isDraft: false }))
        return undefined
      },
      'Creating pull request for feature into main\n\nhttps://github.com/o/r/pull/42\n',
    )
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/repo' })
    await $.tool.call({ tool: 'Bash', command: 'gh pr create --fill' })
    await wait(50)
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', ...BAND_PROPS })
    expect(await ui.find({ type: 'Text', text: /PR #42: 1 Checks grün.*bereit zum Mergen/ })).toBeDefined()
  })
})
