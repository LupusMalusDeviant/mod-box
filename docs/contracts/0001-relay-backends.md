# Vertrag 0001: relay mit Backends je Rolle

**Status:** abgenommen am 3. November 2026 (E1–E11 wie empfohlen, herdr gestrichen) · **Stand:** 3. November 2026, Nachtrag 1 (Abschnitt 14 und 14.1, N1–N28) zur Abnahme · **Betrifft:** `plugins/relay` (heute 0.3.0)

Heute startet relay jeden Worker als `claude -p`. Künftig wählt jede Rolle ihr **Backend**: `claude`, `codex` oder `opencode`. Über opencode erreicht relay auch Ollama und OpenRouter. Warteschlange, Timeout, `owns`, Relay-Pakete und die drei Werkzeuge bleiben gleich. Neu sind die Backend-Schnittstelle, eine Schreibprüfung nach jedem Lauf, die gleich für alle Backends greift, Token-Angaben im Paket, Ollama als Ersatz-Verdichter und eine Warteschlange, die auf der Platte liegt.

Dieser Vertrag legt Schnittstellen, Formate und Verhalten fest. Die Entscheidungen in Abschnitt 11 sind getroffen (jeweils der Vorschlag), herdr ist gestrichen. Die Ergebnisse der Prüfungen V1–V4 stehen in Abschnitt 12.

---

## 1. Geprüfte Fassungen

Geprüft am 3. November 2026 auf dem Rechner des Nutzers (Windows 11) mit `--help` und, wo die Hilfe nichts sagt, an den Zeichenketten der installierten Programme.

| Programm | Fassung | Pfad | Anmerkung |
|---|---|---|---|
| Claude Code | `2.1.310` | `~/.local/bin/claude` (echte `.exe`) | Optionen wie heute in `register.ts` verwendet, alle vorhanden. |
| Codex CLI | `codex-cli 0.166.0` | `npm/codex` ist ein Shell- bzw. `.cmd`-Starter; die eigentliche Datei ist `npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe` | Ein `.cmd` lässt sich ohne Shell nicht starten (siehe 2.5). |
| OpenCode | `opencode v2.2.5` | `npm/opencode` startet `npm/node_modules/@opencode/cli/bin/opencode.exe` | Benutzt standardmäßig einen Hintergrunddienst (siehe 3.3). |
| Ollama | `0.40.13` | `AppData/Local/Programs/Ollama/ollama` | Installiert sind nur Cloud-Modelle (`kimi-k3:cloud`, `deepseek-v4-pro:cloud`), **kein lokales**. |
| git | `2.55.0.windows.5` | | Für die Schreibprüfung und die Worktrees. |

Diese Fassungen gelten als **geprüfte Fassungen**. relay liest beim ersten Lauf eines Backends `--version` und zeigt die Fassung in `worker_status`. Weicht die Hauptfassung ab, warnt `worker_status` einmal, gestartet wird trotzdem.

---

## 2. Backend-Schnittstelle

### 2.1 Typen

Neue Datei `plugins/relay/hooks/backends.ts`. Sie enthält **nur reine Funktionen** (kein `$`), damit Aufbau und Auslesen ohne Prozesse testbar sind. Gestartet wird weiter zentral in `register.ts`.

```ts
export type BackendId = 'claude' | 'codex' | 'opencode'

// Was ein Lauf braucht; relay füllt es aus Rolle, Rollen-Datei und Einstellungen.
export type LaunchSpec = {
  role: string
  task: string                 // Aufgabentext, wie beim Auftrag
  protocol: string             // protocolPrompt(role, brief, owns), unverändert
  isNew: boolean               // keine Session bekannt → neue
  sessionId?: string           // bekannte Session der Rolle (Fortsetzen) oder vorab vergebene (neu)
  model?: string               // im Format des Backends
  effort?: string              // '' = Standard der CLI
  owns: string[]
  allowedTools: string[]       // Claude-Regeln; andere Backends übersetzen, was geht (2.4)
  disallowedTools: string[]
  cwd: string                  // Projektordner oder Worktree der Rolle (Abschnitt 4)
  isGitRepo: boolean
  bin: string[]                // Programm plus feste Vorab-Argumente (2.5)
  settings: BackendSettings    // die Einstellungen dieses Backends (Abschnitt 8)
}

// Was gestartet wird. Kein Shell-Aufruf, nie.
export type Invocation = {
  argv: string[]
  input?: string                    // stdin
  env: Record<string, string>       // zusätzlich zur geerbten Umgebung
  presetSessionId?: string          // vorab vergebene ID, gilt bis parse etwas anderes meldet
  tempFiles?: { path: string; content: string }[] // vor dem Start schreiben, danach löschen
}

export type Usage = {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  reasoningTokens?: number
  costUsd?: number                  // nur, wenn die CLI einen Betrag meldet
  turns?: number
  model?: string                    // wie von der CLI gemeldet
}

export type RunError = {
  kind: 'budget' | 'auth' | 'session-not-found' | 'model' | 'sandbox' | 'cli' | 'unknown'
  message: string                   // höchstens 500 Zeichen, aus JSON oder stderr
}

// Was ein Lauf ergab, unabhängig vom Backend.
export type RunOutcome = {
  answer: string                    // Volltext des Workers inkl. ```relay-Block
  sessionId?: string                // für den nächsten Lauf der Rolle
  usage: Usage
  error?: RunError
}

export type ProcessResult = {
  stdout: string
  stderr: string
  exitCode?: number                 // aus dem Ende von $.process.spawn ({ code, signal }, V1)
  isTimedOut: boolean
  isStoppedByLimit: boolean         // Token-Grenze (Abschnitt 5.2)
}

export interface Backend {
  id: BackendId
  capabilities: {
    budgetUsd: boolean              // CLI kann einen Höchstbetrag selbst durchsetzen
    presetSessionId: boolean        // relay darf die ID vorab vergeben
    inProcessOwnsGuard: boolean     // relays Edit/Write-Hooks greifen im Worker
    sandbox: boolean                // OS-Sandbox der CLI
    usage: 'cost' | 'tokens' | 'both'
    streamsEvents: boolean          // stdout ist JSONL, live lesbar
  }
  build(spec: LaunchSpec): Invocation
  // Live-Auswertung für Token-Grenze und Anzeige; optional.
  onLine?(line: string, acc: Usage): Usage
  parse(result: ProcessResult): RunOutcome
  versionArgv(bin: string[]): string[]
}

export const BACKENDS: Record<BackendId, Backend>
```

### 2.2 Ablauf in `register.ts`

`start()` wird backend-neutral:

1. `effective()` liefert zusätzlich `backend` (Rolle → Rollen-Datei → `defaultBackend`).
2. Arbeitsordner vorbereiten (Abschnitt 4): Ordner wählen, bei `writeCheck` Schnappschuss nehmen.
3. `inv = BACKENDS[id].build(spec)`, `tempFiles` schreiben, `$.process.spawn({ argv: inv.argv, cwd, input: inv.input, env: { ...basisEnv, ...inv.env } })`.
4. stdout zeilenweise an `onLine` geben (falls vorhanden), Token-Grenze prüfen, Timeout wie heute.
5. `outcome = parse(result)`; `outcome.sessionId ?? inv.presetSessionId` wird die Session der Rolle.
6. Schreibprüfung (Abschnitt 4), dann `finish()` wie heute: Paket suchen, sonst Ersatz-Verdichter, Paket schreiben, melden.

`basisEnv` ist für **alle** Backends `RELAY_WORKER=1`, `RELAY_CWD`, bei `enforceOwns` `RELAY_OWNS`. Bei codex und opencode greift das nicht direkt (kein Claude-Plugin geladen), schützt aber, wenn so ein Worker selbst `claude` startet: dort schaltet sich relay dann als Worker, nicht als Orchestrator.

### 2.3 Ein weiteres Backend hinzufügen

1. In `backends.ts` ein Objekt, das `Backend` erfüllt, und den Namen in `BackendId` und `BACKENDS` eintragen.
2. In `plugin.json` die Einstellung `<id>Bin` und, falls nötig, eigene Einstellungen anlegen; `defaultBackend` bekommt die neue Option.
3. Eine gefälschte CLI in `plugins/relay/tests/fakes.ts` und Testfälle nach Abschnitt 10.
4. Die geprüfte Fassung in Abschnitt 1 dieses Vertrags eintragen (Vertrag zuerst ändern, dann bauen).

Kandidaten, die so später dazukommen können, sind z. B. Gemini CLI oder Aider. Sie sind **nicht** Teil dieses Vertrags.

### 2.4 Was je Backend aus den Rollen-Angaben wird

| Angabe | claude | codex | opencode |
|---|---|---|---|
| `protocol` | `--append-system-prompt` | `-c developer_instructions=<JSON-String>` (JSON ist gültiges TOML) | eigener Agent über `OPENCODE_CONFIG_CONTENT` (siehe 3.3), `--agent relay-<rolle>` |
| `model` | `--model` | `-m` | `-m <provider>/<modell>[#variante]`, Pflicht mit `/`, sonst Abbruch vor dem Start |
| `effort` | `--effort` | `-c model_reasoning_effort="<stufe>"` (`xhigh`/`max` → `high`) | wird ignoriert, Variante steckt im Modellnamen; `worker_status` sagt das |
| `allowedTools` | `--allowedTools` | wird ignoriert (keine Werkzeugregeln) | wird ignoriert |
| `disallowedTools` | `--disallowedTools` | nur `Bash(...)`-Regeln wirken indirekt über die Sandbox (kein Netz, siehe 4.2); sonst ignoriert | `Bash(<muster>:*)` → `permission.bash["<muster>*"] = "deny"`; andere Regeln ignoriert |
| Budget | `--max-budget-usd` | – (Token-Grenze, 5.2) | – (Token-Grenze, 5.2) |

Was ignoriert wird, steht einmal in `worker_status` hinter der Rolle (`· ignoriert: allowedTools`), damit niemand sich auf eine Regel verlässt, die nicht greift.

### 2.5 Programmaufruf ohne Shell

`$.process.spawn` startet ohne Shell. Unter Windows lassen sich `.cmd`-Starter so nicht aufrufen. Daher:

- Die Einstellungen `claudeBin`, `codexBin`, `opencodeBin`, `ollamaBin` nehmen einen Programmnamen, einen vollständigen Pfad **oder** eine JSON-Liste (`["node", "C:/…/codex.js"]`). Die Liste ist das Programm plus feste Vorab-Argumente, z. B. für einen Starter, der über `node` läuft. Die gefälschten CLIs der Tests brauchen das nicht (Abschnitt 10.1).
- Scheitert der Start (Programm nicht gefunden), meldet das Paket `failed` mit dem Hinweis, den vollständigen Pfad zur `.exe` einzutragen, für codex mit dem Pfad aus Abschnitt 1.

---

## 3. Die drei Backends im Einzelnen

### 3.1 claude (heutiges Verhalten, unverändert)

**Start (neu):**
```
claude -p --output-format json --permission-mode <permissionMode>
  --append-system-prompt <protocol> --session-id <uuid>
  [--model m] [--effort e] [--max-budget-usd n] [--allowedTools …] [--disallowedTools …]
stdin: Aufgabe
```
**Fortsetzen:** wie oben, statt `--session-id` `--resume <id>`.
**Session-ID:** vorab von relay vergeben (`crypto.randomUUID()`), `session_id` aus dem JSON gewinnt.
**Auslesen:** ein JSON-Objekt auf stdout: `result` → Antwort, `session_id`, `num_turns` → `turns`, `total_cost_usd` → `costUsd`, `usage.input_tokens`/`output_tokens`/`cache_read_input_tokens` → Token, falls vorhanden.
**Fehler:**

| Lage | Abbildung |
|---|---|
| `is_error` mit `subtype` `error_max_budget_usd` | `error.kind = 'budget'`; Paket des Workers bleibt, Status `done` wird zu `partial` |
| `is_error` sonst | `kind = 'cli'`, Meldung `worker error (<subtype>)` wie heute |
| stdout kein JSON | Antwort = stdout wie heute |
| stdout leer, Exit ≠ 0 | `kind = 'cli'`, stderr gekürzt |

`argv` muss für claude **zeichengleich** zu 0.3.0 bleiben (Regressionstest, Abschnitt 10).

### 3.2 codex

**Start (neu):**
```
codex exec --json --sandbox <codexSandbox> --cd <cwd>
  -c approval_policy="never"
  -c developer_instructions=<JSON-String von protocol>
  [-m m] [-c model_reasoning_effort="e"] [--skip-git-repo-check, wenn kein git]
  -
stdin: Aufgabe
```
`codexSandbox` ist `workspace-write` (Standard) oder `read-only`. `danger-full-access` und `--dangerously-bypass-approvals-and-sandbox` setzt relay **nie**.

**Fortsetzen:**
```
codex exec resume --json <thread_id>
  -c sandbox_mode="<codexSandbox>" -c approval_policy="never"
  -c developer_instructions=<…> [-m m] [-c model_reasoning_effort="e"] [--skip-git-repo-check]
  -
stdin: Aufgabe
```
Wichtig: `codex exec resume` kennt in 0.166.0 **weder `--sandbox` noch `--cd`**. Die Sandbox wird daher über `-c sandbox_mode=…` gesetzt, das Arbeitsverzeichnis über `cwd` des Prozesses. Ein Test prüft, dass ein Fortsetzen nie ohne Sandbox-Angabe startet.

**Session-ID:** kann nicht vorab vergeben werden. Sie kommt aus dem ersten Ereignis `thread.started` (`thread_id`). Fehlt sie (Absturz vor dem ersten Ereignis), bleibt die Rolle ohne Session und der nächste Lauf startet neu; das Paket sagt es unter `risks`.

**Auslesen (JSONL, ein Ereignis je Zeile; Ereignisnamen in der installierten Fassung gefunden):**

| Ereignis | Verwendung |
|---|---|
| `thread.started` `{ thread_id }` | `sessionId` |
| `item.completed` mit `item.type = "agent_message"` | `item.text`; die **letzte** solche Nachricht ist die Antwort |
| `turn.completed` `{ usage: { input_tokens, cached_input_tokens, output_tokens, reasoning_output_tokens } }` | Token, über alle Züge summiert |
| `turn.failed` `{ error: { message } }` | `error` |
| `error` `{ message }` | `error` |
| alles andere | wird ignoriert (nur für die Live-Anzeige) |

Die genauen Feldnamen werden beim Bau mit einem echten Lauf als Testvorlage festgehalten (Prüfung K5). Kosten in USD meldet codex nicht; `costUsd` bleibt leer.

**Fehler:**

| Lage | Abbildung |
|---|---|
| `turn.failed` oder `error` beim Fortsetzen, Meldung enthält „not found“ | `kind = 'session-not-found'`: relay vergisst die Session, startet **nicht** von selbst neu und meldet `failed` mit „Session weg, nächster Auftrag startet frisch“ |
| Meldung zu Anmeldung (401, „login“) | `kind = 'auth'` |
| Meldung zur Sandbox | `kind = 'sandbox'` |
| sonst | `kind = 'unknown'` mit Meldung |
| keine Ereignisse, Exit ≠ 0 | `kind = 'cli'`, stderr gekürzt |
| Exit 0, aber keine `agent_message` | Antwort leer → wie heute „Worker produced no usable answer“ |

### 3.3 opencode (Ollama, OpenRouter und andere Anbieter)

**Start (neu und Fortsetzen, ein Befehl):**
```
opencode run --format json --standalone --auto
  -m <provider>/<modell> --agent relay-<rolle>
  --session <id> --title "relay <rolle>"
  <aufgabe>
env: OPENCODE_CONFIG_CONTENT=<JSON, siehe unten>
```
- `--session <id>`: laut Hilfe „Session ID to continue, or to create if it does not exist“. Ob opencode eine frei gewählte ID annimmt oder ein eigenes Format verlangt (z. B. Vorsilbe `ses_`), ist ohne echten Lauf nicht prüfbar (K2). **Gebaut ist daher der sichere Weg:** Ein neuer Lauf startet ohne `--session`, relay übernimmt die ID aus dem ersten Ereignis (`sessionID`) und setzt beim nächsten Lauf mit `--session <id>` fort. Zeigt K2, dass vorab vergebene IDs gehen, kann das nachgezogen werden.
- `--standalone`: eigener Server je Lauf statt des gemeinsamen Hintergrunddienstes. Nur so beendet das Stoppen bei Timeout auch die Arbeit; sonst läuft die Session im Dienst weiter (Prüfung K3).
- `--auto`: bestätigt alles, was nicht ausdrücklich verboten ist. Ohne `--auto` hängt ein nicht-interaktiver Lauf an der ersten Rückfrage bis zum Timeout. Die Verbote kommen aus der Konfiguration.
- `OPENCODE_CONFIG_CONTENT` (Umgebungsvariable, in der installierten Fassung vorhanden) enthält einen Agenten für die Rolle:
  ```json
  {
    "agent": { "relay-<rolle>": { "mode": "primary", "prompt": "<protocol>" } },
    "permission": { "bash": { "git push*": "deny" }, "edit": { "<owns>/**": "allow", "*": "deny" } }
  }
  ```
  Ob `permission.edit` Pfadmuster versteht, prüft der Bau (Prüfung K4). Wenn nicht, entfällt der `edit`-Teil, und es gilt nur die Schreibprüfung nach dem Lauf.
- Aufgabe als Argument: Ob `opencode run` stdin liest, ist aus der Hilfe nicht ersichtlich (Prüfung K1). Bis dahin geht die Aufgabe als Argument. Ist sie länger als 24 000 Zeichen (Windows-Grenze für eine Befehlszeile: 32 767), schreibt relay sie nach `.relay/tmp/<rolle>-<lauf>.md` und übergibt `--file <pfad>` mit dem kurzen Argument „Die Aufgabe steht in der angehängten Datei.“

**Auslesen (JSONL; jedes Ereignis `{ type, timestamp, sessionID, … }`, Aufbau in der installierten Fassung gefunden):**

| Ereignis | Verwendung |
|---|---|
| beliebig, Feld `sessionID` | `sessionId` |
| `text` `{ part: { text } }` | Antwort: alle Textteile in Reihenfolge, durch Leerzeile getrennt |
| `step_finish` `{ part: { tokens, cost, reason } }` | Token (`tokens.input`, `tokens.output`, `tokens.reasoning`, `tokens.cache.read`) und `cost` über alle Schritte summiert |
| `step_start` | `turns` +1 und Modellname für die Anzeige |
| `error` `{ error: { message } }` | `error`; opencode setzt dann Exit 1 |
| `tool_use` | nur Live-Anzeige |

**Fehler:** wie bei codex (`auth`, `model` bei „model not found“ bzw. unbekanntem Anbieter, `unknown`, `cli`). Liefert ein Anbieter `cost = 0` (Ollama), steht im Paket `$0.00` nur, wenn Token > 0 sind; sonst fehlt der Betrag.

**Ollama und OpenRouter** sind für relay einfach Modellnamen: `ollama/kimi-k3:cloud`, `openrouter/<anbieter>/<modell>`. Anmeldung und Anbieter richtet der Nutzer in opencode selbst ein; relay fasst `opencode auth` nicht an.

---

## 4. Gleiche Sicherheit für alle Backends

### 4.1 Ausgangslage

Die `owns`-Prüfung von relay hängt an Claude-Code-Hooks (`tool.call` für Edit, Write, NotebookEdit). Sie greift nur in claude-Workern und auch dort nicht für Schreiben über die Shell. In codex- und opencode-Workern greift sie gar nicht.

### 4.2 Die Optionen

| | Option | Was sie leistet | Was sie kostet / wo sie endet |
|---|---|---|---|
| **A** | **Schreibprüfung per git nach jedem Lauf** (melden) | Für alle Backends gleich, erfasst auch Shell-Schreiben und Commits. Fremde Schreibvorgänge erscheinen im Paket als Konflikt. | Verhindert nichts, meldet nur. Braucht ein git-Repo. Laufen mehrere Rollen gleichzeitig im selben Ordner, ist nicht eindeutig, wer was schrieb (4.3). Von git ignorierte Dateien bleiben unsichtbar. |
| **B** | A **plus Zurücksetzen** | Änderungen außerhalb von `owns` werden rückgängig gemacht. | Nur sauber für Dateien, die vorher unverändert waren. Neue Dateien müssten gelöscht werden; relay verschiebt sie stattdessen nach `.relay/quarantine/`. Bei vorher schon geänderten Dateien braucht es eine Inhaltskopie vor dem Lauf. Fehlerträchtig, schwer nachzuvollziehen. |
| **C** | **Eigener Worktree je Rolle** | Jede Rolle arbeitet in `.relay/worktrees/<rolle>` auf dem Branch `relay/<rolle>`. Gleichzeitige Rollen stören sich nicht, A wird eindeutig, der Hauptordner bleibt unberührt. | Platz auf der Platte; nicht eingecheckte Dinge (z. B. `node_modules`, `.env`) fehlen im Worktree. Die Ergebnisse müssen zurück in den Hauptstand: relay führt nichts selbst zusammen, sondern meldet den Branch unter `needs_from_main` (Entscheidung E3). Der Worktree-Pfad einer Rolle bleibt fest, sonst finden claude und codex ihre Sessions nicht wieder. |
| **D** | **Codex-Sandbox** (`workspace-write`) | Betriebssystem-Sperre: codex schreibt nur in seinem Arbeitsordner, Netz ist aus (damit scheitert auch `git push`). | Kennt `owns` nicht, nur den ganzen Ordner. Erst zusammen mit C wird daraus „nur die eigene Rolle“. Wie gut die Sandbox unter Windows greift, ist am Rechner zu prüfen (Plan P9). |
| **E** | **opencode-Rechte** in der Konfiguration (3.3) | Verbietet `git push` und, falls unterstützt, Schreiben außerhalb von `owns` schon im Lauf. | Hängt an opencodes Rechtesystem; Shell-Befehle mit Umleitung (`>`) prüft es nicht nach Pfad. |
| – | Codex- oder opencode-Hooks einrichten | Wäre eine Prüfung im Lauf. | **Verworfen:** relay müsste fremde Konfiguration (`~/.codex/…`, Hook-Vertrauen) ändern. Das sind Regeldateien des Nutzers. |

### 4.3 Vorschlag

- **A ist Pflicht für alle Backends** (Einstellung `writeCheck`, Standard `report`), auch für claude als zweite Linie hinter dem Hook.
- **D immer für codex** (`workspace-write`), **E immer für opencode**.
- **C wahlweise je Rolle** (`isolation: "worktree"` in der Rollen-Datei oder beim Auftrag). Empfohlen für codex- und opencode-Rollen, die parallel zu anderen schreiben.
- **B nicht jetzt.** Kann später als `writeCheck: "revert"` dazukommen, mit eigenem Vertrag.

Rollen im **selben** Ordner, die gleichzeitig laufen: Eine Änderung außerhalb der eigenen `owns`, die in den `owns` einer anderen gerade laufenden Rolle liegt, gilt als „vermutlich von <andere Rolle>“ und ist kein Konflikt. Eine Änderung außerhalb aller `owns` wird bei **allen** gleichzeitig laufenden Rollen als „nicht eindeutig zuzuordnen“ gemeldet. Wer das nicht will, wählt C oder bei Entscheidung E2 die Variante „seriell“.

### 4.4 Ablauf der Schreibprüfung

Reine Funktion in `protocol.ts`, Eingabe sind zwei Schnappschüsse, Ausgabe die Liste der Pfade:

```ts
export type Snapshot = {
  head: string                         // git rev-parse HEAD ('' ohne Commit)
  dirty: Record<string, string>        // Pfad → git hash-object des Inhalts, für alles aus git status
}

export type WriteCheck = {
  checked: boolean                      // false: kein git, git-Fehler, writeCheck off
  reason?: string                       // warum nicht geprüft
  changed: { path: string; change: 'created' | 'modified' | 'deleted' }[]
  outside: string[]                     // außerhalb von owns, eindeutig dieser Rolle
  unattributed: string[]                // außerhalb aller owns, Rollen liefen parallel
  byOtherRole: { path: string; role: string }[]
}

export function compareSnapshots(before: Snapshot, after: Snapshot, committed: string[], owns: readonly string[],
  others: { role: string; owns: readonly string[] }[]): WriteCheck
```

Schnappschuss: `git status --porcelain=v1 -z --untracked-files=all`, dann für alle genannten Pfade auf einmal `git hash-object --stdin-paths`. Der Wert in `dirty` ist der Hash, bei einer gelöschten Datei `deleted`, bei einer von git noch nicht erfassten Datei `new:<hash>` (daran erkennt `compareSnapshots` „created“). Pfade unter `relayDir` zählen nicht. Commits während des Laufs: `git diff --name-status -z <head vorher> <head nachher>` ergibt `committed`. Ohne `owns` prüft relay trotzdem und trägt alle Änderungen unter `artifacts` nach, die der Worker nicht selbst genannt hat.

**Im Paket:** neues Feld `write_check` (wird mit gespeichert). Gibt es `outside`-Pfade:
- Status `done` wird zu `partial`,
- jeder Pfad steht unter `risks` als `wrote outside owns: <pfad> (<art>)`,
- die Kopfzeile bekommt `⚠ wrote outside owns (n)`.

`unattributed` und `byOtherRole` stehen nur unter `risks`, der Status bleibt.

---

## 5. Kosten

### 5.1 Was im Paket steht

Die Kopfzeile bleibt eine Zeile, ergänzt um Backend und Verbrauch:

```
[relay] ingester · run 4 finished (claude · 6 turns, $0.42)
[relay] coder · run 2 finished (codex · gpt-5.5-codex · 48.2k in (31.0k cached) / 3.1k out tokens)
[relay] scout · run 7 finished (opencode · ollama/kimi-k3:cloud · 12.4k in / 1.8k out tokens, $0.00, stopped after 30 min)
```

(`$0.00` nach der Regel aus 3.3: Ollama meldet `cost = 0` bei Token > 0.)

Tausender als `k` mit einer Nachkommastelle, unter 1000 als Zahl. `packet.json` bekommt die Felder `usage` (Typ `Usage`) und `backend`. Jede Rolle führt in `$.store` eine Summe (`totals: Usage`), `worker_status` zeigt sie: `· 3 runs, 112.0k in / 9.4k out tokens` bzw. `$1.27`.

### 5.2 Grenzen

- **claude:** `maxBudgetUsd` wie heute, durchgesetzt von der CLI.
- **codex, opencode:** kein Betrag. Es gilt `runTimeoutMin` wie heute, dazu wahlweise **`maxTokensPerRun`** (Standard `0` = aus): relay zählt die Token live aus den JSONL-Ereignissen (`onLine`) und stoppt den Lauf, sobald Ein- plus Ausgabe-Token die Grenze überschreiten. Weil erst nach einem Zug gezählt wird, kann ein Lauf die Grenze um einen Zug überschreiten. Das Paket meldet dann `partial`, Kopfzeile `stopped at <n> tokens`. Ob es diese Grenze überhaupt geben soll, ist Entscheidung E4.

---

## 6. Paket-Ersatz

Heute baut `fallbackModel` (Haiku) über `$.model.complete` ein fehlendes Paket nach. Neu:

| Einstellung | Werte | Standard |
|---|---|---|
| `fallbackBackend` | `claude` · `ollama` · `off` | `claude` |
| `fallbackModel` | Modell für `claude` | `claude-haiku-5-5` |
| `ollamaModel` | Modell für `ollama` | leer (dann wie `off`) |
| `ollamaBin` | wie 2.5 | `ollama` |

`fallbackCompress` bleibt als Schalter erhalten; aus heißt dasselbe wie `fallbackBackend: off`.

**Ollama-Aufruf:** `ollama run <ollamaModel> --format json --hidethinking --nowordwrap`, stdin = `fallbackPrompt(role)` + Leerzeile + `---` + Antwort des Workers. Keine Netz-API, nur der Prozess. Antwort durch `parsePacket`, `compressed_by: 'fallback'`, die Kopfzeile nennt das Modell: `(packet built by fallback compressor ollama/<modell>)`.

**Kette:** Scheitert Ollama (nicht erreichbar, kein JSON, Timeout 120 s), versucht relay **nicht** von selbst Haiku, sondern meldet `failed` wie heute bei ausgeschaltetem Ersatz (Entscheidung E5).

**Hinweis Datenschutz:** Auf dem Rechner des Nutzers sind nur Ollama-**Cloud**-Modelle installiert. Mit ihnen verlässt die Worker-Antwort den Rechner genauso wie mit Haiku. Ein lokales Modell muss der Nutzer erst holen (`ollama pull <modell>`, Plan P11a).

**Weniger Ersatz bei codex:** codex kann seine letzte Antwort mit `--output-schema` auf ein JSON-Schema zwingen. Dann ginge aber der Volltext verloren, oder er müsste als Feld im JSON stehen. Vorschlag: **nicht nutzen**, das Paket kommt wie bei allen Backends aus dem ```relay-Block. Offen als Entscheidung E6.

---

## 7. Warteschlange auf der Platte

### 7.1 Ort und Format

Datei `<relayDir>/queue.json` (Standard `.relay/queue.json`). Sie wird wie `runs/` in die `.gitignore` eingetragen. Dazu kommen `.relay/tmp/` und `.relay/worktrees/`. Alle Einträge schreibt die bestehende `ensureGitignore` (bei `gitignore: true`).

```ts
export type QueueFile = {
  version: 1
  owner?: { session: string; heartbeatAt: string }   // ISO-Zeit, siehe 7.3
  jobs: QueuedJob[]
}

export type QueuedJob = {
  id: string                    // 'j_' + 12 Zeichen zufällig
  role: string
  task: string
  model?: string
  enqueuedAt: string            // ISO
  state: 'queued' | 'running'
  run?: number                  // gesetzt bei running
  startedAt?: string
  backend: BackendId            // beim Einreihen festgehalten
}
```

Fertige Läufe stehen **nicht** in der Datei; sie werden beim Abschluss entfernt (ihr Ergebnis liegt in `runs/`).

**Schreiben:** Nach jeder Änderung schreibt relay die ganze Datei, vorher die alte Fassung nach `queue.json.bak`. Ist `queue.json` beim Lesen kaputt, gilt `queue.json.bak`, und `worker_status` meldet das einmal. `$.fs` kann weder umbenennen noch löschen (V3), daher bleibt es bei diesem Verfahren; `tempFiles` werden nach dem Lauf mit leerem Inhalt überschrieben statt gelöscht.

### 7.2 Wiederaufnahme bei `session.start`

1. Datei lesen. Jobs mit `state: 'queued'` bleiben in ihrer Reihenfolge und starten über `pump`, sobald Plätze frei sind.
2. Jobs mit `state: 'running'` sind tot: Kindprozesse enden mit dem Modul. relay schreibt für sie ein Paket `failed` mit „unterbrochen durch Neustart des Plugins oder Ende der Session“, macht die Schreibprüfung gegen den Stand vor dem Lauf (der Schnappschuss liegt in `.relay/tmp/<rolle>-<lauf>.snapshot.json`), entfernt den Job und meldet das Paket auf dem gewohnten Weg. **Kein automatischer Neustart** (Entscheidung E7), weil ein halber Lauf schon geschrieben haben kann.
3. Die Session-IDs der Rollen bleiben wie heute in `$.store`; der nächste Auftrag setzt fort.
4. Rollen, die es in `$.store` nicht mehr gibt, deren Jobs aber in der Datei stehen, legt relay mit den Werten der Rollen-Datei neu an. Gibt es die Rolle dort auch nicht, bleibt der Job liegen und `worker_status` zeigt ihn als „verwaist“.

### 7.3 Zwei Sessions im selben Projekt

Jede Claude-Session mit relay würde dieselbe Datei lesen. `owner` legt fest, wer die Warteschlange abarbeitet:

- Beim Start übernimmt eine Session die Datei, wenn `owner` fehlt oder `heartbeatAt` älter als 3 Minuten ist. Sie erneuert `heartbeatAt` jede Minute (`$.clock.after`).
- Eine zweite Session sieht einen frischen `owner` und arbeitet **nur lesend**: `worker_status` zeigt Rollen und Warteschlange mit dem Hinweis „wird von einer anderen Session abgearbeitet“, `worker_send` lehnt mit dieser Meldung ab (Entscheidung E8).

### 7.4 Was sich für die Werkzeuge ändert

- `worker_send` bekommt die Felder `backend` (`claude` · `codex` · `opencode`, gespeichert wie `model`) und `isolation` (`shared` · `worktree`, gespeichert).
- `worker_status` zeigt je Rolle Backend, Fassung, Verbrauch, ignorierte Regeln; die Warteschlange mit Wartezeit; verwaiste Jobs.
- Kein weiteres Werkzeug. Einen wartenden Job zu löschen bleibt außen vor (Entscheidung E9).

---

## 8. Einstellungen und Rollen-Datei

Neu in `plugin.json` (`userConfig`), alles mit Standard so, dass ohne Änderung alles wie in 0.3.0 läuft:

| Einstellung | Standard | Bedeutung |
|---|---|---|
| `defaultBackend` | `claude` | Backend für Rollen ohne eigene Angabe |
| `codexBin` | `codex` | wie 2.5 |
| `codexSandbox` | `workspace-write` | `workspace-write` · `read-only` |
| `opencodeBin` | `opencode` | wie 2.5 |
| `opencodeStandalone` | an | `--standalone` (3.3) |
| `writeCheck` | `report` | `report` · `off` (4.3) |
| `isolation` | `shared` | Standard für Rollen: `shared` · `worktree` |
| `maxTokensPerRun` | `0` | nur codex/opencode (5.2) |
| `fallbackBackend`, `ollamaModel`, `ollamaBin` | siehe 6 | |

Hinweis: `writeCheck: report` ist neu standardmäßig an. Ohne git-Repo meldet es nur einmal „nicht geprüft“, verhält sich also wie 0.3.0.

Rollen-Datei, neue Felder je Rolle: `backend`, `isolation`. `model` gilt im Format des Backends. Beispiel:

```json
{
  "roles": {
    "ingester": { "backend": "opencode", "model": "ollama/kimi-k3:cloud", "owns": ["wiki/sources/"] },
    "coder":    { "backend": "codex", "model": "gpt-5.5-codex", "effort": "high", "owns": ["src/"], "isolation": "worktree" },
    "architect": { "owns": ["wiki/_schema/"], "effort": "high" }
  }
}
```

Wechselt eine Rolle ihr Backend, ist ihre alte Session nutzlos: relay verwirft sie (wie `fresh: true`) und sagt es in der Antwort von `worker_send`.

---

## 9. Live-Protokoll

relay schreibt während jedes Laufs `<relayDir>/runs/<rolle>/live.log`: für JSONL-Backends eine lesbare Zeile je Ereignis (Werkzeug, Text gekürzt, Token), für claude nur Start und Ende (claude liefert mit `--output-format json` nichts zwischendurch). Die Datei wird bei jedem Lauf der Rolle neu begonnen. Weil `$.fs` nicht anhängen kann, schreibt relay sie gesammelt, höchstens alle 2 Sekunden und am Ende des Laufs.

herdr ist gestrichen (Abnahme am 3. November 2026). Wer mitlesen will, öffnet `live.log` selbst.

---

## 10. Tests

Alle Tests laufen mit `claude plugin test .` wie in der CI (Ubuntu und Windows). Keine echten Modelle, keine echten Prozesse, kein Python.

### 10.1 Gefälschte CLIs

`claude plugin test` startet keine echten Prozesse (V2). Die Grundfunktionen werden im Test per `on('process.spawn' | 'process.run' | 'fs.read' | …, …)` ersetzt. Daher sind die gefälschten CLIs **TypeScript-Helfer** in `plugins/relay/tests/fakes.ts`, die `process.spawn` abfangen (abgenommen am 3. November 2026, statt der früher geplanten Node-Skripte):
- Der Helfer erkennt am ersten argv-Eintrag bzw. am Unterbefehl, welche CLI gemeint ist (`claude`, `codex`, `opencode`, `ollama`), und hält jeden Aufruf (`argv`, `cwd`, `env`, `input`) in einer Liste fest, die der Test prüft.
- Er spielt ein Szenario, das der Test je Aufruf festlegt: `ok`, `no-packet`, `error`, `auth`, `session-not-found`, `crash` (Exit 2 ohne Ausgabe), `hang` (endet erst beim Abbruch), `slow-tokens` (ein Zug je Uhr-Takt mit 10k Token), `write-outside` und `commit` (verändern die gefälschten `process.run`-Antworten von git so, als hätte der Worker außerhalb von `owns` geschrieben bzw. committet).
- Die Ausgabe hat das Format der echten CLI, abgeleitet aus Testvorlagen echter Läufe (K5).
- Zeit läuft über `mock.clock` (V4), damit Timeout, Herzschlag und Token-Grenze ohne Warten testbar sind.

### 10.2 Testfälle

| Bereich | Fälle | Marke |
|---|---|---|
| Aufbau je Backend (rein) | neu/fortsetzen, mit/ohne Modell, Effort-Abbildung, Sandbox bei codex-Fortsetzen vorhanden, `--skip-git-repo-check` ohne git, opencode-Modell ohne `/` abgelehnt, lange Aufgabe → `--file`, claude-argv zeichengleich zu 0.3.0 | [Claude-prüfbar] |
| Auslesen je Backend (rein) | Antwort, Session-ID, Token-Summe über mehrere Züge, Kosten, jeder Fehlerfall aus 3.1–3.3, kaputte JSONL-Zeilen werden übersprungen | [Claude-prüfbar] |
| Regel-Übersetzung (rein) | `Bash(git push:*)` → opencode-Muster, ignorierte Regeln werden gemeldet | [Claude-prüfbar] |
| Schreibprüfung (rein) | `compareSnapshots`: neu, geändert, gelöscht, vorher schon geändert und erneut geändert, Commit im Lauf, parallel laufende Rollen, kein git | [Claude-prüfbar] |
| Start (mit Fake) | jede Fake-CLI startet, Paket kommt an, Session-ID wird beim nächsten Lauf weitergegeben | [Claude-prüfbar] |
| Warteschlange (mit Fake) | `maxParallel 1`: zweiter Auftrag wartet; gleiche Rolle zweimal → seriell; `queue.json` nach jedem Schritt; Neustart mit `queued` → läuft weiter; Neustart mit `running` → Paket „unterbrochen“; kaputte Datei → `.bak`; zweite Session → nur lesend | [Claude-prüfbar] |
| Timeout (mit Fake `hang`) | Lauf wird gestoppt, Paket `partial`/`failed`, Platz wird frei | [Claude-prüfbar] (mit `mock.clock`) |
| Token-Grenze (Fake `slow-tokens`) | Stopp nach Überschreiten, Kopfzeile | [Claude-prüfbar] |
| Schreibprüfung (Fake `write-outside`, `commit`) mit gefälschten git-Antworten | Konflikt im Paket, Status `partial` | [Claude-prüfbar] |
| Ersatz-Verdichter (Fake `no-packet` + Fake-ollama) | Paket aus Ollama, Ollama scheitert → `failed` | [Claude-prüfbar] |
| Live-Protokoll | `live.log` wird geschrieben, für JSONL-Backends je Ereignis eine Zeile | [Claude-prüfbar] |

---

## 11. Entscheidungen

**Abgenommen am 3. November 2026: in allen Punkten der Vorschlag.** Die Alternativen bleiben zur Nachvollziehbarkeit stehen.

1. **E1 – Sicherheitsmodell.** Vorschlag: A (Schreibprüfung, melden) Pflicht für alle, D für codex, E für opencode, C (Worktree) wahlweise je Rolle, B (zurücksetzen) nicht jetzt. Alternativen: C für alle Nicht-claude-Rollen erzwingen; oder B gleich mitbauen.
2. **E2 – Parallele Rollen im selben Ordner.** Vorschlag: erlaubt, Zuordnung nach 4.3 („vermutlich von …“, „nicht eindeutig“). Alternative „seriell“: Bei `writeCheck: report` laufen schreibende Rollen im geteilten Ordner nacheinander, nur Worktree-Rollen parallel.
3. **E3 – Ergebnisse aus Worktrees.** Vorschlag: relay führt nicht zusammen; das Paket nennt den Branch `relay/<rolle>` unter `needs_from_main`, der Main-Agent bzw. der Nutzer führt zusammen. Alternative: relay führt selbst per `git merge --ff-only` zusammen, wenn nur `owns`-Pfade geändert wurden.
4. **E4 – Token-Grenze für codex/opencode.** Vorschlag: `maxTokensPerRun` einbauen, Standard aus. Alternative: weglassen, nur Timeout.
5. **E5 – Ersatz-Kette.** Vorschlag: Scheitert Ollama, gibt es kein Paket (`failed`, Volltext lesbar). Alternative: dann Haiku versuchen.
6. **E6 – `--output-schema` bei codex.** Vorschlag: nicht nutzen. Alternative: nutzen, mit Volltext als Feld im JSON, dafür fast nie Ersatz-Verdichter bei codex.
7. **E7 – Unterbrochene Läufe nach Neustart.** Vorschlag: als `failed` melden, nicht neu starten. Alternative: wieder vorn einreihen.
8. **E8 – Zweite Session im selben Projekt.** Vorschlag: nur lesend, `worker_send` lehnt ab. Alternative: `worker_send` reiht in die Datei ein, die besitzende Session arbeitet es ab (dann kommen die Pakete aber bei der anderen Session an).
9. **E9 – Wartende Aufträge zurückziehen.** Vorschlag: nicht in diesem Vertrag. Alternative: `worker_cancel` (Job aus der Warteschlange entfernen, laufenden Lauf stoppen) gleich mit festlegen.
10. **E10 – Ort der Warteschlange.** Vorschlag: `.relay/queue.json` im Projekt (sichtbar, von mehreren Sessions lesbar). Alternative: nur im `$.store` des Plugins wie die Rollen.
11. **E11 – Fassung von relay.** Vorschlag: 0.4.0, weil Einstellungen und Paketfelder hinzukommen, aber nichts Bestehendes bricht.

---

## 12. Voraussetzungen und Prüfungen vor dem Bau

**Plugin-API** (geprüft am 3. November 2026 an den Typen in `.claude-plugin/types/claude-code/index.d.ts`):
- **V1** Liefert `$.process.spawn` den Exit-Code? **Ja.** Der Strom liefert `{ stream, text }`-Teile und endet mit `{ code, signal }`.
- **V2** Startet `$.process.spawn` in `claude plugin test` echte Prozesse? **Nein.** Grundfunktionen werden im Test per `on(...)` ersetzt; daher die TS-Fälschungen aus 10.1.
- **V3** Kann `$.fs` umbenennen und löschen? **Nein** (nur read, write, list, exists, stat). Es bleibt bei `.bak` (7.1), `tempFiles` werden überschrieben.
- **V4** Lässt sich die Uhr im Test vorspulen? **Ja**, über `mock.clock`.
- **V5** Beendet das Abbrechen des Stroms unter Windows den ganzen Prozessbaum (codex startet Sandbox-Prozesse)? **Offen**, nur am echten Rechner prüfbar (P9).

**CLIs** (erste Bauaufgabe, jeweils mit einem echten, kurzen Lauf):
- **K1** Liest `opencode run` die Aufgabe von stdin?
- **K2** Nimmt `opencode run --session` eine von relay vergebene ID an, und in welchem Format?
- **K3** Stoppt `--standalone` beim Beenden des Prozesses auch die Arbeit?
- **K4** Versteht opencodes `permission.edit` Pfadmuster?
- **K5** Genaue JSON-Felder von codex (`turn.completed.usage`, `item.completed.item`) und opencode (`step_finish.part.tokens`) als Testvorlage festhalten.

---

## 13. Umsetzungsplan

| Nr. | Schritt | Marke |
|---|---|---|
| P1 | Vertrag abnehmen, Entscheidungen E1–E11 eintragen (erledigt 3. November 2026) | [braucht Nutzer/Hardware] |
| P2 | Voraussetzungen V1–V4 an der Plugin-API prüfen, Ergebnis hier eintragen (erledigt) | [Claude-prüfbar] |
| P3 | Je ein echter Kurzlauf codex und opencode (Ollama-Cloud) zur Testvorlage, K1–K5 beantworten (kostet Token, braucht Anmeldung) | [braucht Nutzer/Hardware] |
| P4 | `backends.ts`: Typen, claude-Backend als Auszug aus `start()`/`finish()` ohne Verhaltensänderung, Regressionstest argv | [Claude-prüfbar] |
| P5 | codex- und opencode-Backend mit Aufbau, Live-Lesen, Auslesen, Fehlerabbildung, Tests mit Vorlagen | [Claude-prüfbar] |
| P6 | Fake-CLIs (`tests/fakes.ts`) und Start-Tests | [Claude-prüfbar] |
| P7 | Schreibprüfung `compareSnapshots` und Einbindung, Paketfeld `write_check` | [Claude-prüfbar] |
| P8 | Worktree-Isolation je Rolle | [Claude-prüfbar] |
| P9 | Codex-Sandbox und V5 unter Windows im echten Lauf prüfen (Schreiben außerhalb, `git push`, Stopp bei Timeout) | [braucht Nutzer/Hardware] |
| P10 | Warteschlange auf der Platte, Wiederaufnahme, Besitzer-Herzschlag | [Claude-prüfbar] |
| P11 | Ersatz-Verdichter Ollama bauen | [Claude-prüfbar] |
| P11a | Probe mit lokalem Modell (`ollama pull`) | [braucht Nutzer/Hardware] |
| P12 | `live.log` | [Claude-prüfbar] |
| P13 | Kosten/Token in Kopfzeile, `packet.json`, Summen in `worker_status` | [Claude-prüfbar] |
| P14 | README, Skill `relay-orchestrator`, `plugin.json`-Einstellungen, Fassung | [Claude-prüfbar] |
| P15 | Echter Gesamtlauf: drei Rollen, je ein Backend, parallel, mit Neustart dazwischen | [braucht Nutzer/Hardware] |

**Stand 3. November 2026:** P4–P8 und P10–P14 sind in relay 0.4.0 gebaut und mit `claude plugin test plugins/relay` geprüft (`hooks/backends.test.ts`, `hooks/protocol.test.ts`, `tests/relay.test.ts`). Die Testvorlagen für codex und opencode folgen den Feldnamen aus Abschnitt 3; ob sie zeichengenau stimmen, zeigt erst P3 (K5). Offen sind P3, P9, P11a und P15.

---

## 14. Nachtrag 1 (3. November 2026): Befunde aus dem Codex-Review von 0.4.0

Ein Codex-Review von relay 0.4.0 (Stand `284a4a9`) fand 15 Befunde. Wo ihre Behebung vertragliches Verhalten ändert, steht es hier; die Entscheidungen E1–E11 bleiben unverändert. **Zur Abnahme durch den Nutzer.** Die Nummern sind die des Reviews.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N1 | opencode bekommt die Aufgabe **immer** als Datei `<relayDir>/tmp/<rolle>-<lauf>.md` unter einem **absoluten** Pfad (`--file <pfad>`), als Nachricht nur den festen Satz „The task is in the attached file.“. Die Aufgabe steht nie in `argv`. Die Datei wird nach dem Lauf geleert (7.1). Die Grenze von 24 000 Zeichen entfällt. Eine gespeicherte Session-ID, die als Option gelesen werden könnte (nicht `[A-Za-z0-9][A-Za-z0-9_.:-]*`), wird nicht übergeben; der Lauf beginnt neu (gilt auch für `codex exec resume`). | 3.3 „Aufgabe als Argument“ | 1 (Option-Injektion, Zugangsdaten in argv), 15 (relativer Pfad im Worktree) |
| N2 | Alles, was relay ablegt oder meldet, wird vorher von Zugangsdaten bereinigt: `live.log`, `full.md` (Aufgabe und Antwort), `packet.json`, das gemeldete Paket, Fehlermeldungen und stderr-Auszüge (vor dem Kürzen), Hinweise in `worker_status`. Erkannt werden `Authorization`-Kopfzeilen, `Bearer`/`Basic`, `name=wert` bzw. `name: wert` für Namen mit `key`, `secret`, `token`, `password`, `credential`, Benutzer:Passwort in URLs, private Schlüssel und bekannte Schlüsselformate. `queue.json` hält einen wartenden Auftrag weiter wörtlich, weil relay ihn so starten muss. | 2.2 Schritt 6, 9 | 2 |
| N3 | Abfertigen: Je Modul läuft höchstens ein `pump` zugleich. Job, Rolle und Platz werden **vor** dem ersten `await` reserviert; scheitert danach das Schreiben der Warteschlange, wird die Reservierung zurückgenommen. | 2.2 | 3 |
| N4 | Schreiben der Warteschlange: Alle Schreibvorgänge (Auftrag, Start, Abschluss, Herzschlag) laufen nacheinander; jeder schreibt den Stand, der bei seinem Beginn gilt. | 7.1 „Schreiben“ | 4 |
| N5 | Besitz der Warteschlange: `owner` bekommt ein Feld `token` (zufällig je Modul). Wer übernehmen darf (7.3), schreibt seinen Anspruch, wartet 2 Sekunden (`CLAIM_SETTLE_MS`) und liest zurück; nur wenn sein `token` noch dasteht, arbeitet er die Warteschlange ab. Vor **jedem** späteren Schreiben liest relay die Datei: steht dort ein anderer `token` mit frischem Herzschlag, hört die Session auf (nur noch lesend, `worker_send` lehnt ab) und überschreibt nichts. Ein echtes exklusives Anlegen gibt `$.fs` nicht her (V3); der Anspruch ist daher ein Lease mit Prüfung. Bis der Anspruch entschieden ist, wartet `worker_send`. | 7.1 Typ `QueueFile`, 7.3 | 5 |
| N6 | Lässt sich `queue.json` nicht schreiben, nimmt `worker_send` den Auftrag **nicht an** („task not accepted, nothing was started“) und startet nichts; scheitert das Schreiben erst beim Start, bleibt der Job `queued` und ungestartet, die Antwort nennt den Grund. Eine vorhandene, aber nicht lesbare `queue.json` gilt **nicht** als fehlend: die Session arbeitet die Warteschlange dann nicht ab, überschreibt die Datei nicht und `worker_send` lehnt mit dem Lesefehler ab. | 7.1, 7.2 | 6 |
| N7 | Verlangt eine Rolle `isolation: "worktree"` und lässt sich der Worktree nicht herstellen (kein git, `git worktree add` scheitert), scheitert der Lauf **vor dem Start** mit `failed` („Worker was not started: …“); relay weicht nicht mehr auf den Projektordner aus. Die Session der Rolle bleibt unberührt. | 4.2 Option C, 4.3 | 7 |
| N8 | Ein vorhandener Worktree wird nur benutzt, wenn er (a) kein Link ist, (b) über `realPath` genau auf `<projekt>/<relayDir>/worktrees/<rolle>` auflöst, (c) in `git worktree list` dieses Repositorys steht und (d) auf `refs/heads/relay/<rolle>` steht; sonst wie N7. Löst `relayDir` selbst außerhalb des Projekts auf, ebenso. Die Einstellung `relayDir` muss relativ und ohne `..` sein; sonst gilt `.relay`, und `worker_status` sagt es einmal. | 4.2 Option C, 8 | 8 |
| N9 | Umbenennungen: `parsePorcelain` liefert zur Umbenennung auch die Quelle (`orig`), die im Schnappschuss als `deleted` zählt. `parseNameStatus` liefert `{ path, change }[]`: Umbenennung = Quelle `deleted` + Ziel `created`, Kopie = Ziel `created`, `A` = `created`, `D` = `deleted`. `compareSnapshots` nimmt `committed` daher als `{ path: string; change: 'created' \| 'modified' \| 'deleted' }[]`. Nur im Index angelegte, umbenannte oder kopierte Pfade zählen wie unversionierte als `new:<hash>`. | 4.4 Signatur `compareSnapshots`, Schnappschuss | 9 |
| N10 | Hashen: Exit-Code und Anzahl der Hashes von `git hash-object --stdin-paths` werden geprüft; scheitert der Stapel, wird jeder Pfad einzeln gehasht (`git hash-object -- <pfad>`), Pfade mit Zeilenumbruch immer einzeln. Ein Pfad, den git nicht hashen kann, ist `unhashed` und wird nie als „gleich“ gewertet: `WriteCheck` bekommt das Feld `incomplete?: string[]`, jeder Eintrag steht unter `risks` als `write check incomplete: …`, die Kopfzeile trägt `⚠ write check incomplete`. Ebenso, wenn `git status` oder `git diff` scheitert. | 4.4 Typ `WriteCheck`, „Im Paket“ | 10 |
| N11 | Commits ab einem ungeborenen HEAD: Ist `head` vor oder nach dem Lauf leer, vergleicht `git diff --name-status -z` mit dem leeren Baum des Repositorys (`git hash-object -t tree --stdin`, Ersatz `4b825dc…`). | 4.4 „Commits während des Laufs“ | 11 |
| N12 | Groß-/Kleinschreibung in `owns` folgt dem Dateisystem des Projekts: relay prüft beim Start mit einer Probedatei in `<relayDir>/tmp/`, ob es Groß- und Kleinschreibung unterscheidet. Standard ist **unterscheiden**. Der Worker erfährt es über `RELAY_OWNS_CASE` (`sensitive` · `insensitive`) neben `RELAY_OWNS`. `ownershipDenial`, `isOwnedPath` und `compareSnapshots` nehmen dafür eine Option `{ caseInsensitive?: boolean }`. | 2.2 `basisEnv`, 4.4 | 12 |
| N13 | Wiederaufnahme: Ein `running`-Job verlässt die Warteschlange nur, wenn sein Paket „unterbrochen“ abgelegt wurde. Gibt es die Rolle nirgends oder scheitert die Meldung, bleibt der Job `running` in der Datei, `worker_status` zeigt ihn („interrupted … not reported yet“), der nächste Start versucht es erneut. | 7.2 Schritt 2 und 4 | 13 |
| N14 | Ein Job läuft mit dem Backend, das beim Einreihen festgehalten wurde (`job.backend`), und dem Modell, das dabei galt (`job.model`, jetzt immer gesetzt). Die übrigen Rollen-Angaben (owns, effort, Werkzeuge, Isolation) gelten wie bisher zum Start. | 7.1 `QueuedJob` | 14 |

**Tests** (`claude plugin test plugins/relay`): neue Datei `tests/hardening.test.ts`, je Befund mindestens ein Fall, der mit dem Stand `284a4a9` fehlschlägt; reine Fälle in `hooks/backends.test.ts`. Die gefälschte Welt (`tests/fakes.ts`) kann jetzt verzögerte und scheiternde Lese- und Schreibvorgänge, Links, registrierte Worktrees, Umbenennungen, nicht hashbare Pfade, einen ungeborenen HEAD, ein Dateisystem ohne Groß-/Kleinschreibung und Platzhalter-Zugangsdaten in jedem Ausgabeweg. Im eigenständigen Lauf ist die Registrierung der drei Werkzeuge Pflicht: Ist relay geladen und fehlt ein Werkzeug, schlägt der Test fehl, statt still zu bestehen. Echte Testvorlagen der CLIs (K5, P3) und das Beenden des Prozessbaums unter Windows (V5, P9) bleiben offen.

### 14.1 Zweites Codex-Review (3. November 2026)

Ein zweites Codex-Review (Stand `63ba3bf`) fand 14 weitere Befunde (6 hoch, 8 mittel). Die Zeilen N15–N28 ergänzen die Tabelle oben; **auch sie zur Abnahme durch den Nutzer.** „Befund“ nennt die Nummer im zweiten Review.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N15 | Kein Bericht geht verloren. Ein scheiternder Ersatz-Verdichter ergibt ein `failed`-Paket mit Volltext und dem Fehler, nie einen verlorenen Lauf. Die Ablage (`full.md`, `packet.json`) und die Meldung sind getrennte Schritte: Ist abgelegt, bekommt der Job `delivery: "stored"` in `queue.json`. Scheitert Ablage oder Meldung (auch ein abgelehntes `session.append` oder ein verworfenes `prompt.submit`), bleibt der Job in der Warteschlange, `worker_status` sagt es, und jeder Herzschlag versucht es erneut. Ein Neustart meldet einen Job mit `delivery: "stored"` aus dem abgelegten Paket („delivered after a restart“), nicht als „interrupted“. Erst nach Ablage **und** Meldung verlässt der Job die Warteschlange. | 7.1 `QueuedJob`, 7.2 Schritt 4, N13 | 1 |
| N16 | Anspruch: Unmittelbar vor dem Schreiben des eigenen Anspruchs liest relay `queue.json` erneut. Steht dort ein frischer fremder Anspruch, wird er geachtet (Session liest nur, seine Jobs bleiben); sonst übernimmt relay den frisch gelesenen Stand samt Jobs. **Grenze, nicht behoben:** `$.fs` kennt kein exklusives Anlegen (V3). Zwischen diesem Lesen und dem Schreiben bleibt ein Fenster von wenigen Millisekunden, in dem sich zwei Ansprüche kreuzen können; die Prüfung nach 2 Sekunden (N5) und der Abgleich vor jedem Schreiben fangen das meist, aber nicht beweisbar immer. Ein echtes Lock braucht ein exklusives Anlegen in der Plugin-API. | N5, 7.3 | 2 |
| N17 | Ablage nur im Projekt: Vor dem ersten Schreiben in `<relayDir>`, `tmp/`, `runs/<rolle>/` und vor `git worktree add` prüft relay jeden vorhandenen Teil des Pfads: kein Link, `realPath` im Projekt (Vergleich nach Groß-/Kleinschreibung des Dateisystems). Liegt `<relayDir>` außerhalb, arbeitet die Session die Warteschlange nicht ab und `worker_send` lehnt ab; liegt `tmp/` oder `runs/<rolle>/` außerhalb, startet der Lauf nicht (`failed`), und ein Paket ohne Ablage sagt „Not stored: …“. | N8, 8 | 3 |
| N18 | Bereinigen von `name=wert`: Der Wert wird ganz genommen, auch in doppelten, einfachen oder maskierten (`\"…\"`) Anführungszeichen mit Leerzeichen. Zahlen werden ebenfalls ersetzt (`password=12345678`), außer bei Zählernamen (`max_tokens`, `tokens`, `token_count`, `token_limit` …) mit einer Anzahl. | N2 | 4 |
| N19 | Auch der Umschlag von `packet.json` (Backend, Verbrauch, Modellname) wird bereinigt, nicht nur das Paket. | N2 | 7 |
| N20 | Ein Rollen-Brief, in dem relay Zugangsdaten erkennt, steht nicht in `argv`: der System-Prompt bekommt ihn bereinigt mit dem Zusatz „(the full brief comes with the task)“, die Aufgabe (stdin bzw. Datei) beginnt mit dem vollen Brief. Ein Brief ohne Zugangsdaten bleibt wie in 0.3.0 im System-Prompt; das `claude`-argv ist dann byte-gleich. **Grenze:** Was die Erkennung (N2, N18) nicht als Zugangsdaten erkennt, steht weiter im System-Prompt. | 3.1, 3.2, 3.3 | 5 |
| N21 | Ist `queue.json` leer oder fehlt sie und ist die Sicherung gut, liest relay die Sicherung (`isFromBackup`) und schreibt die leere Hauptdatei nie über die Sicherung; `worker_status` sagt es einmal. | 7.1 „Schreiben“ | 6 |
| N22 | Zuordnung bei parallelen Läufen: relay merkt sich, welche Rollen seit dem Schnappschuss eines Laufs im selben Ordner liefen, auch die schon fertigen. Änderungen in deren `owns` zählen nicht als „außerhalb“. Der Verlauf wird gelöscht, sobald kein früher gestarteter Lauf mehr läuft. | 4.4 | 10 |
| N23 | Eine Session gehört zu einem Ordner: Die Rolle speichert `sessionDir`. Läuft der nächste Auftrag in einem anderen Ordner (Wechsel von `shared` zu `worktree` oder zurück, auch bei einer in 0.3.0 gespeicherten Session, die als Projektordner gilt), beginnt eine neue Session, und das Paket sagt es; `worker_send` sagt beim Wechsel der Isolation, dass die alte Session verworfen wurde. | 4.2 Option C, 7.1 | 11 |
| N24 | Projekt in einem Unterordner des Repositorys: Schnappschuss und Hashes laufen an `git rev-parse --show-toplevel`, alle Pfade (Status, Diff, `owns`-Vergleich) sind relativ zum Projekt (`--show-prefix`); Pfade außerhalb des Projekts erscheinen als `../…` und zählen als außerhalb. | 4.4 | 13 |
| N25 | Die Aufgabendatei (`tmp/<rolle>-<lauf>.md`) wird nach jedem Lauf geleert, wie er auch endet (`finally`), und beim Wiederaufnehmen nach einem Neustart. | N1 | 8 |
| N26 | Ein Fehler des Backends nach dem Paket (Fehlerereignis oder Exit-Code ≠ 0 bei codex und opencode) macht aus `done` ein `partial`; `risks` nennt den Fehler. Ein Exit-Code ≠ 0 zählt bei codex und opencode immer als Fehler, auch mit Antwort. | 3.2, 3.3 `parse` | 12 |
| N27 | Ohne git: Das erste Paket der Session sagt einmal „write check skipped: the project is no git repository …“, ebenso `worker_status`. Scheitert git selbst (nicht „not a git repository“), ist die Prüfung `incomplete` (N10), bei jedem Lauf. | 4.4 | 14 |
| N28 | Scheitert das Abfertigen, weil `queue.json` nicht geschrieben werden kann (N6), versucht jeder erfolgreiche Herzschlag es erneut; ein wartender Job startet, sobald die Datei wieder schreibbar ist. | N6 | 9 |

**Tests:** neue Datei `tests/hardening2.test.ts` (25 Fälle) und reine Fälle in `hooks/backends.test.ts` (Bereinigen von Zahlen und Anführungszeichen, `toProjectPath`, Exit-Code, Sicherung bei leerer Hauptdatei). Jeder neue Fall schlägt mit dem Stand `63ba3bf` fehl, außer dem Gegenfall „a brief without credentials keeps the 0.3.0 argv“, der beide Stände absichert. **Offen bleiben:** das nicht atomare Anspruchsfenster (N16), Aufträge im Klartext in `queue.json` und `queue.json.bak` (N2), nicht erkannte Zugangsdaten im Brief (N20), K5/P3 und V5/P9.
