// Mod Box: "Open with" for the file tree's context menu. Which programs to look for, how to find
// them on each system, how to start one with a file, and which kinds fit a file. No $ here: the
// pane runs the commands this file builds.

export type AppKind = 'editor' | 'ide' | 'browser'
export type Os = 'linux' | 'darwin' | 'win32'

export type AppSpec = {
  id: string
  label: string
  kind: AppKind
  // Windows: a command on PATH, or an exe registered under "App Paths" (browsers, Notepad++, Visual Studio)
  win?: string[]
  // macOS: the application's name for `open -a`
  mac?: string
  // Linux: a command on PATH
  linux?: string[]
}

export const APPS: AppSpec[] = [
  { id: 'vscode', label: 'VS Code', kind: 'editor', win: ['code'], mac: 'Visual Studio Code', linux: ['code'] },
  { id: 'cursor', label: 'Cursor', kind: 'editor', win: ['cursor'], mac: 'Cursor', linux: ['cursor'] },
  { id: 'zed', label: 'Zed', kind: 'editor', win: ['zed'], mac: 'Zed', linux: ['zed', 'zeditor'] },
  { id: 'sublime', label: 'Sublime Text', kind: 'editor', win: ['subl', 'sublime_text.exe'], mac: 'Sublime Text', linux: ['subl'] },
  { id: 'notepadpp', label: 'Notepad++', kind: 'editor', win: ['notepad++.exe'] },
  { id: 'notepad', label: 'Notepad', kind: 'editor', win: ['notepad'] },
  { id: 'textedit', label: 'TextEdit', kind: 'editor', mac: 'TextEdit' },
  { id: 'gedit', label: 'Text Editor', kind: 'editor', linux: ['gnome-text-editor', 'gedit', 'kate', 'mousepad'] },
  { id: 'rider', label: 'Rider', kind: 'ide', win: ['rider', 'rider64.exe'], mac: 'Rider', linux: ['rider'] },
  { id: 'idea', label: 'IntelliJ IDEA', kind: 'ide', win: ['idea', 'idea64.exe'], mac: 'IntelliJ IDEA', linux: ['idea'] },
  { id: 'webstorm', label: 'WebStorm', kind: 'ide', win: ['webstorm', 'webstorm64.exe'], mac: 'WebStorm', linux: ['webstorm'] },
  { id: 'pycharm', label: 'PyCharm', kind: 'ide', win: ['pycharm', 'pycharm64.exe'], mac: 'PyCharm', linux: ['pycharm'] },
  { id: 'vs', label: 'Visual Studio', kind: 'ide', win: ['devenv.exe'] },
  { id: 'xcode', label: 'Xcode', kind: 'ide', mac: 'Xcode' },
  { id: 'edge', label: 'Edge', kind: 'browser', win: ['msedge.exe'], mac: 'Microsoft Edge', linux: ['microsoft-edge'] },
  { id: 'chrome', label: 'Chrome', kind: 'browser', win: ['chrome.exe'], mac: 'Google Chrome', linux: ['google-chrome', 'chromium'] },
  { id: 'firefox', label: 'Firefox', kind: 'browser', win: ['firefox.exe'], mac: 'Firefox', linux: ['firefox'] },
  { id: 'brave', label: 'Brave', kind: 'browser', win: ['brave.exe'], mac: 'Brave Browser', linux: ['brave-browser', 'brave'] },
]

// Windows: each name either on PATH (Get-Command) or in "App Paths" (HKCU, then HKLM). Names come in
// through the environment, one per line; the answer is "name<TAB>full path" per found program.
const WIN_DETECT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "foreach ($n in ($env:OW_NAMES -split \"`n\")) {",
  "  if (-not $n) { continue }",
  "  $p = (Get-Command $n -CommandType Application -All | Where-Object { $_.Source -match '\\.(exe|cmd|bat)$' } | Select-Object -First 1).Source",
  "  if (-not $p) { foreach ($h in 'HKCU:','HKLM:') { $k = Get-ItemProperty \"$h\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\$n\"; if ($k -and $k.'(default)') { $p = $k.'(default)'; break } } }",
  "  if ($p) { Write-Output (\"$n`t\" + $p.Trim('\"')) }",
  "}",
  "exit 0",
].join('\n')
const MAC_DETECT = 'for a in "$@"; do open -Ra "$a" >/dev/null 2>&1 && printf "%s\\t%s\\n" "$a" "$a"; done'
const LINUX_DETECT = 'for c in "$@"; do p=$(command -v "$c" 2>/dev/null) && printf "%s\\t%s\\n" "$c" "$p"; done'

/** The command that finds the programs; its output is read with readDetected. */
export function detectCommand(os: Os): { argv: string[]; env?: Record<string, string> } {
  if (os === 'win32') {
    const names = [...new Set(APPS.flatMap(a => a.win ?? []))]
    return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', WIN_DETECT], env: { OW_NAMES: names.join('\n') } }
  }
  if (os === 'darwin') return { argv: ['sh', '-c', MAC_DETECT, 'sh', ...APPS.flatMap(a => (a.mac ? [a.mac] : []))] }
  return { argv: ['sh', '-c', LINUX_DETECT, 'sh', ...new Set(APPS.flatMap(a => a.linux ?? []))] }
}

/** id → what to start (a path on Windows/Linux, the app name on macOS), for the programs found. */
export function readDetected(os: Os, stdout: string): Record<string, string> {
  const found = new Map<string, string>()
  for (const line of stdout.split(/\r?\n/)) {
    const [name, target] = line.split('\t')
    if (name && target) found.set(name.toLowerCase(), target.trim())
  }
  const out: Record<string, string> = {}
  for (const a of APPS) {
    const names = os === 'win32' ? a.win : os === 'darwin' ? (a.mac ? [a.mac] : []) : a.linux
    const hit = (names ?? []).map(n => found.get(n.toLowerCase())).find(Boolean)
    if (hit) out[a.id] = hit
  }
  return out
}

// Windows: Start-Process with the program and the file from the environment, so no quoting of
// user paths ends up in a command line. A .cmd/.bat starter (code.cmd) runs without its console.
const WIN_LAUNCH = [
  "$ErrorActionPreference = 'Stop'",
  "$a = @{ FilePath = $env:OW_EXE; ArgumentList = '\"' + $env:OW_TARGET + '\"' }",
  "if ($env:OW_EXE -match '\\.(cmd|bat)$') { $a.WindowStyle = 'Hidden' }",
  "Start-Process @a",
].join('\n')

/** How to start a found program with a file or folder. */
export function launchCommand(os: Os, target: string, path: string, linuxLaunch: string): { argv: string[]; env?: Record<string, string> } {
  if (os === 'win32') {
    return { argv: ['powershell', '-NoProfile', '-NonInteractive', '-Command', WIN_LAUNCH], env: { OW_EXE: target, OW_TARGET: path.replace(/\//g, '\\') } }
  }
  if (os === 'darwin') return { argv: ['open', '-a', target, '--', path] }
  return { argv: ['sh', '-c', linuxLaunch, 'sh', target, path] }
}

/** How to show a file in the system's file manager. */
export function revealCommand(os: Os, path: string, isDir: boolean): { argv: string[]; env?: Record<string, string> } {
  if (os === 'win32') {
    const p = path.replace(/\//g, '\\')
    return { argv: ['explorer.exe', isDir ? p : `/select,${p}`] }
  }
  if (os === 'darwin') return { argv: ['open', isDir ? '' : '-R', path].filter(Boolean) }
  return { argv: ['xdg-open', isDir ? path : path.replace(/\/[^/]*$/, '') || '/'] }
}

const WEB = /\.(html?|xhtml|svg|pdf|xml)$/i
const IMAGE = /\.(png|jpe?g|gif|webp|ico|bmp|avif)$/i
const SOLUTION = /\.(sln|slnx|csproj|fsproj|vbproj|vcxproj|xcodeproj|xcworkspace)$/i
const CODE = /\.(m?[jt]sx?|cjs|cts|mts|json|jsonc|css|s[ac]ss|less|py|cs|fs|vb|java|kt|kts|go|rs|c|cc|cpp|h|hpp|swift|rb|php|sql|sh|bash|ps1|psm1|bat|cmd|vue|svelte|astro|md|mdx|ya?ml|toml|ini|env|gradle|lua|dart|r|scala|ex|exs|tf|dockerfile)$/i

/** Which kinds of program fit a file, in the order the menu shows them. */
export function kindsFor(path: string, isDir: boolean): AppKind[] {
  const name = path.split('/').pop() ?? path
  if (isDir) return ['editor', 'ide']
  if (SOLUTION.test(name)) return ['ide', 'editor']
  if (WEB.test(name)) return ['browser', 'editor', 'ide']
  if (IMAGE.test(name)) return ['browser']
  if (CODE.test(name) || /^(dockerfile|makefile|\.[\w.-]+rc|\.gitignore|\.editorconfig)$/i.test(name)) return ['editor', 'ide']
  return ['editor']
}

export type ExtraApp = { label: string; command: string }

/** The person's own programs from the option: "Name=command; Name2=command" ({path}, {dir} as in "open with"). */
export function readExtraApps(text: string): ExtraApp[] {
  return text
    .split(/;|\n/)
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const at = part.indexOf('=')
      return at > 0 ? { label: part.slice(0, at).trim(), command: part.slice(at + 1).trim() } : { label: part.split(/\s+/)[0] ?? part, command: part }
    })
    .filter(x => x.label && x.command)
}
