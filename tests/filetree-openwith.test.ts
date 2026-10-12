import { describe, expect, mock, test } from 'claude-code/testing'
import { detectCommand, kindsFor, launchCommand, readDetected, readExtraApps } from '../mods/filetree/hooks/apps'

// The file tree's "Open with" menu: programs found once, offered by file type, started without
// putting the path into a command line.
const PANE = { component: 'Pane', requestId: 'filetree', props: { bodyColumns: 100, placement: 'right', scroll: { bodyRows: 40 } } }
const norm = (p: unknown) => String(p).replace(/\\/g, '/').replace(/^[A-Za-z]:/, '')
const settle = () => new Promise(done => (globalThis as any).setTimeout(done, 50))
const FOUND = 'code\tC:\\Tools\\VSCode\\bin\\code.cmd\nmsedge.exe\tC:\\Program Files\\Edge\\msedge.exe\n'

const boot = async ($: any, on: any, runs: any[]) => {
  mock.clock(on); mock.store(on)
  on('session.id', () => ({ value: 's' }))
  on('session.usage', () => ({ value: { startedAt: 0, context: { tokens: 1, window: 200000, percent: 0 }, rateLimits: [] } }))
  on('session.start', (_$: any, e: any) => ({ sessionId: 's', cwd: e.cwd }))
  on('command.register', (_$: any, e: any) => ({ value: { command: e.name } }))
  on('command.list', () => ({ value: [] }))
  on('tool.register', () => ({ value: {} }))
  on('session.messages', () => ({ value: [] }))
  on('config.list', () => ({ value: [] }))
  on('env.get', (_$: any, e: any) => ({ value: e.name === 'OS' ? 'Windows_NT' : undefined }))
  on('ui.status', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.copy', () => ({ value: { isCopied: true } }))
  on('session.cwd', () => ({ value: 'C:/w' }))
  on('session.root', () => ({ value: 'C:/w' }))
  on('fs.exists', () => ({ value: false }))
  on('fs.read', () => ({ deny: 'none' }))
  on('fs.stat', () => ({ deny: 'none' }))
  on('fs.list', (_$: any, e: any) =>
    norm(e.path).replace(/\/$/, '') === '/w'
      ? { value: [
          { name: 'index.html', kind: 'file', size: 10, mtimeMs: 1, isLink: false },
          { name: 'app.ts', kind: 'file', size: 10, mtimeMs: 1, isLink: false },
        ] }
      : { value: [] })
  on('process.run', (_$: any, e: any) => {
    runs.push(e)
    const script = String(e.argv?.[4] ?? '')
    const stdout = script.includes('OW_NAMES') ? FOUND : ''
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.run', () => ({ text: '' }))
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: 'C:/w' })
}

describe('Open with: what fits a file', () => {
  test('kinds by file type', () => {
    expect(kindsFor('/w/index.html', false)[0]).toBe('browser')
    expect(kindsFor('/w/app.ts', false)).toEqual(['editor', 'ide'])
    expect(kindsFor('/w/App.sln', false)[0]).toBe('ide')
    expect(kindsFor('/w/logo.png', false)).toEqual(['browser'])
    expect(kindsFor('/w/src', true)).toEqual(['editor', 'ide'])
  })

  test('programs found on Windows: by PATH name or App Paths exe', () => {
    const found = readDetected('win32', FOUND)
    expect(found.vscode).toBe('C:\\Tools\\VSCode\\bin\\code.cmd')
    expect(found.edge).toBe('C:\\Program Files\\Edge\\msedge.exe')
    expect(found.chrome).toBeUndefined()
    expect(detectCommand('win32').env?.OW_NAMES).toContain('msedge.exe')
  })

  test('a path with quotes or semicolons never ends up in the command line', () => {
    const odd = "C:/w/it's; rm -rf.txt"
    const cmd = launchCommand('win32', 'C:\\Tools\\code.cmd', odd, '')
    expect(cmd.argv.join(' ')).not.toContain('rm -rf')
    expect(cmd.env?.OW_TARGET).toBe("C:\\w\\it's; rm -rf.txt")
    expect(launchCommand('darwin', 'Visual Studio Code', '/w/a.ts', '').argv).toEqual(['open', '-a', 'Visual Studio Code', '--', '/w/a.ts'])
  })

  test('own programs from the option', () => {
    expect(readExtraApps('Rider=rider64 {path}; Notes')).toEqual([
      { label: 'Rider', command: 'rider64 {path}' },
      { label: 'Notes', command: 'Notes' },
    ])
  })
})

describe('Open with: the menu in the pane', () => {
  test('o on a file opens the menu, a found browser opens the html file', { options: { filetree: true, language: 'en' } }, async ($: any, on: any) => {
    const runs: any[] = []
    await boot($, on, runs)
    const ui = await $.ui.mount({ plugin: 'mod-box', surface: 'terminal', ...PANE })
    await settle()
    await ui.key({ key: 'down', in: 'rows' })
    await ui.key({ key: 'o', in: 'rows' })
    await settle()
    expect(await ui.find({ type: 'Text', text: /Open with · / })).toBeDefined()
    expect(await ui.find({ key: 'ow-default' })).toBeDefined()
    expect(await ui.find({ key: 'ow-copy' })).toBeDefined()
    // the cursor row decides which buttons fit; one of the two files is the html file
    const edge = await ui.find({ key: 'ow-edge' })
    const code = await ui.find({ key: 'ow-vscode' })
    expect(edge ?? code).toBeDefined()
    await ui.press({ key: edge ? 'ow-edge' : 'ow-vscode' })
    await settle()
    const launch = runs.find(r => String(r.argv?.[4] ?? '').includes('Start-Process'))
    expect(launch).toBeDefined()
    expect(launch.init.env.OW_EXE).toMatch(edge ? /msedge\.exe$/ : /code\.cmd$/)
    expect(launch.init.env.OW_TARGET).toMatch(edge ? /index\.html$/ : /app\.ts$/)
    // the menu closes after a choice
    expect(await ui.find({ key: 'ow-close' })).toBeUndefined()
    await ui.unmount()
  })
})
