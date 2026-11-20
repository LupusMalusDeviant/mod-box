# Vertrag 0001: relay mit Backends je Rolle

**Status:** abgenommen am 3. November 2026 (E1–E11 wie empfohlen, herdr gestrichen) · **Stand:** 13. November 2026, Nachtrag 1 (Abschnitt 14 und 14.1, N1–N28) abgenommen am 13. November 2026; Nachtrag 2 (Abschnitt 15, N29–N47, Backend `werkbank`) sowie Nachträge 2a (15.4, N48–N57) , 2b (15.5, N58–N67) und 2c (15.6, N68–N72) abgenommen am 18. November 2026; Nachtrag 2d (15.7, N73–N80) abgenommen am 19. November 2026; Nachtrag 2e (15.8, N81–N86) und 2f (15.9, N87–N93) abgenommen am 19. November 2026; Nachtrag 2g (15.10, N94–N98) abgenommen am 19. November 2026; Nachtrag 2h (15.11, N99–N106) und 2i (15.12, N107–N113) abgenommen am 20. November 2026 · **Betrifft:** `plugins/relay` (heute 0.3.0)

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

Ein Codex-Review von relay 0.4.0 (Stand `284a4a9`) fand 15 Befunde. Wo ihre Behebung vertragliches Verhalten ändert, steht es hier; die Entscheidungen E1–E11 bleiben unverändert. **Abgenommen am 13. November 2026.** Die Nummern sind die des Reviews.

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

Ein zweites Codex-Review (Stand `63ba3bf`) fand 14 weitere Befunde (6 hoch, 8 mittel). Die Zeilen N15–N28 ergänzen die Tabelle oben; **abgenommen am 13. November 2026.** „Befund“ nennt die Nummer im zweiten Review.

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

---

## 15. Nachtrag 2 (18. November 2026): viertes Backend `werkbank`

**Status: abgenommen am 18. November 2026** (N29–N47 wie vorgeschlagen). Gegenstück ist Vertrag 0002 im Werkbank-Repo („Werkbank als relay-Backend“, angenommen am 18. November 2026), dort Abschnitt 1 (Programm `werkbank-relay`, JSON-Ausgabe) und „Gegenstück in relay“. Eine relay-Rolle mit `backend: "werkbank"` läuft auf den Werkbank-Servern (fsn1-4/fsn1-5): relay startet am PC das Programm `werkbank-relay`, das den Auftrag beim Leitstand einstellt, wartet und ein JSON-Objekt ausgibt. Die Rolle ist an ihren Worker gebunden und arbeitet je Repo auf **einem** Branch `agent/relay/<rolle>`. Alles Übrige (Warteschlange, Pakete, Bereinigen, Werkzeuge) gilt unverändert. Neue Fassung von relay: **0.5.0** (neue Einstellungen, neues Paketverhalten, nichts Bestehendes bricht).

### 15.1 Änderungen

| Nr. | Änderung | Ersetzt / ergänzt |
|---|---|---|
| N29 | `BackendId` = `'claude' \| 'codex' \| 'opencode' \| 'werkbank'`; `BACKEND_IDS`, `BACKENDS`, `worker_send.backend` und die Option `defaultBackend` bekommen `werkbank`. | 2.1, 7.4, 8 |
| N30 | **Aufruf** (`build`), ohne Shell, Aufgabe auf stdin:<br>`werkbank-relay run --leitstand <werkbankLeitstand> --token-file <werkbankTokenFile> --role <rolle> --run <n> --cwd <projektordner> [--session <id>] [--model m] [--max-turns n] [--timeout-min n] [--allowed-tools a,b] [--disallowed-tools a,b] [--owns p1,p2] --protocol-file <pfad>`<br>Reihenfolge fest wie hier (Regressionstest). `--session` nur beim Fortsetzen und nur mit einer sicheren ID (`isSafeId`, N1), sonst beginnt der Lauf neu. `--max-turns` entfällt, bis relay eine Einstellung dafür hat (heute keine). `--timeout-min` ist `runTimeoutMin` (Laufzeit von `claude` auf dem Worker), entfällt bei `0`. Listen werden mit `,` verbunden. | 2.4, 3 |
| N31 | **Protokoll als Datei:** `protocolPrompt(...)` geht als Temp-Datei `<relayDir>/tmp/<rolle>-<lauf>.protocol.md` unter **absolutem** Pfad an `--protocol-file`; sie wird nach dem Lauf geleert wie die opencode-Aufgabendatei (N25, 7.1). Das Protokoll steht damit nie in `argv`. | 2.1 `tempFiles` |
| N32 | **Abweisen vor dem Start** (Lauf `failed`, „Worker was not started: …“, Session bleibt): Aufgabe (samt vorangestelltem Brief nach N20) über **16 KiB** UTF-8; ein Wert für `--model`, `--allowed-tools`, `--disallowed-tools` oder `--owns`, der mit `-` beginnt oder (bei Listen) ein `,` enthält; `werkbankLeitstand` nicht `http://` oder `https://`. Fehler aus `build` haben dann `kind: 'cli'`, nicht `'model'`. | 2.2 Schritt 3 |
| N33 | **Rollen-Angaben:** `model`, `allowedTools`, `disallowedTools`, `owns` gehen mit; `effort` und `maxBudgetUsd` gibt es bei werkbank nicht → `worker_status` meldet `· ignoriert: effort` (sofern gesetzt). `isolation: "worktree"` wird für werkbank **nicht** angewandt (der Worker hat seinen eigenen Worktree); der Lauf nimmt immer den Projektordner als `--cwd`, `worker_status` meldet `· ignoriert: isolation`. | 2.4, 4.3 C |
| N34 | **Auslesen** (`parse`): genau ein JSON-Objekt auf stdout (Felder nach Vertrag 0002, Abschnitt 1): `answer` → Antwort; `sessionId` → Session der Rolle (nur übernommen, wenn `isSafeId`); `usage.costUsd/turns/inputTokens/outputTokens/model` → `Usage`; `jobId`, `state`, `branch`, `commits[]`, `changedFiles[]`, `verify` → neues Feld `remote` (N36); `error{kind,message}` → `RunError` (N35). Meldung gekürzt und bereinigt (N2). Kein JSON auf stdout: `kind: 'cli'`, Meldung aus stderr bzw. „werkbank-relay printed no JSON“, Antwort leer; ein Paket entsteht dann nicht. | 2.1 `parse`, 3 |
| N35 | **Fehlerarten:** `RunError.kind` bekommt zusätzlich `'network'` und `'repo'`. Abbildung von `error.kind`: `auth`→`auth`, `network`→`network`, `repo`→`repo`, `budget`→`budget` (Tagesbudget, Leitstand `423`), `limit`→`budget`, `cli`→`cli`, sonst `unknown`. Exit-Code ≠ 0 ohne `error` im JSON → `cli`. Bei `budget` ohne Antwort meldet das Paket `failed` (es wurde nichts gestartet). | 2.1 `RunError` |
| N36 | `RunOutcome` bekommt optional `remote = { jobId, state, branch, commits: string[], changedFiles: string[], verify? }` (Typ `RemoteRun`). Es ist gesetzt, sobald das JSON eine `jobId` hat. | 2.1 `RunOutcome` |
| N37 | **Zustände → Paketstatus:** `done` → Paket wie geliefert. `red`, `needs-approval`, `timed-out`, `limit` → aus `done` wird `partial`, unter `risks` steht `werkbank job <jobId> ended <state>: <grund>` (Grund = `error.message`, bei `red` die Prüfzeile aus N38). Fehlt dabei ein Paket, baut relay ein Ersatz-Paket mit Status **`partial`** (Zusammenfassung „werkbank job … ended <state> without a relay packet“), nicht `failed`, weil Commits auf dem Branch liegen können. `failed`, `cancelled` → `failed` (ein Paket des Workers wird auf `failed` gesetzt, der Grund steht unter `risks`). | 3, 4.4 „Im Paket“ |
| N38 | **Prüfbefehl im Paket:** Ist `verify` gesetzt, steht unter `facts` `verify: <command> → exit <exitCode>` und, falls vorhanden, `, tests <passed>/<total> passed, <failed> failed`. | 5.1 |
| N39 | **Schreibprüfung bei `remote`:** Statt der lokalen Schnappschüsse vergleicht relay `remote.changedFiles` mit `owns` (`isOwnedPath`, **groß-/kleinschreibungsgenau**, die Server laufen unter Linux). Die Pfade sind relativ zur Wurzel des Repos; relay rechnet sie mit `--show-prefix` des Projektordners auf Projektpfade um (`toProjectPath`, N24), Pfade außerhalb des Projekts zählen als außerhalb. Jeder Pfad zählt als `modified` (der Leitstand meldet keine Art). Verstoß wie heute: `done` → `partial`, `wrote outside owns: <pfad> (modified)` unter `risks`, Kopfzeile `⚠ wrote outside owns (n)`. `unattributed` und `byOtherRole` gibt es hier nicht (eigener Branch). Für werkbank nimmt relay **keinen** lokalen Schnappschuss, und der Lauf zählt nicht in die Zuordnung paralleler Läufe (4.3, N22), weil er lokal nichts schreibt. Ohne `remote` (Abbruch vor dem Einstellen) gibt es keine Schreibprüfung; das Paket sagt nichts dazu. Mit `writeCheck: off` entfällt auch diese Prüfung. | 4.4, N22, N24 |
| N40 | ***Needs from main*:** Hat `remote` Commits oder geänderte Dateien, steht unter `needs_from_main`: `The changes are on branch <branch> (werkbank job <jobId>, commits <kurz-shas>); relay does not merge them.` Die Commits stehen außerdem unter `artifacts`. | E3, 4.2 C |
| N41 | **Session:** `presetSessionId: false`; relay übernimmt `sessionId` aus dem JSON. Meldet der Lauf eine andere Session als die mitgegebene (Worker war über 30 min weg, Vertrag 0002 Abschnitt 4), bleibt das Paket, wie es ist, und `risks` sagt: `the werkbank session moved (<alt> → <neu>); the worker started fresh, repeat the context it needs.` Die neue Session gilt für den nächsten Lauf. `sessionDir` (N23) ist der Projektordner. | 3, N23 |
| N42 | **Fähigkeiten:** `budgetUsd: false`, `presetSessionId: false`, `inProcessOwnsGuard: false`, `sandbox: false`, `usage: 'both'`, `streamsEvents: true`. Kein `onLine` (stdout trägt nur das End-JSON), daher greift `maxTokensPerRun` nicht. | 2.1 |
| N43 | **Live-Protokoll:** Bei werkbank schreibt relay jede stderr-Zeile von `werkbank-relay` (`queued`, `running auf fsn1-5`, `verifying`, …) bereinigt in `live.log`. | 9 |
| N44 | **Einstellungen** (`plugin.json`, `userConfig`):<br>`werkbankBin` – Standard `werkbank-relay`, wie 2.5;<br>`werkbankLeitstand` – Standard `http://100.73.150.87:5080`;<br>`werkbankTokenFile` – Standard `~/.werkbank/relay.token`; ein führendes `~` ersetzt relay durch `USERPROFILE` bzw. `HOME` (Kindprozesse laufen ohne Shell). relay liest die Datei nie;<br>`werkbankTimeoutMin` – Standard **60**: relays Timeout für einen werkbank-Lauf (Wartezeit im Leitstand plus Lauf), ersetzt für dieses Backend `runTimeoutMin`; `0` = kein Timeout. Ist er nicht größer als `runTimeoutMin`, sagt `worker_status` das einmal. | 8 |
| N45 | **Timeout und Abbruch:** Nach `werkbankTimeoutMin` beendet relay den Prozess wie bei jedem Backend; die Kopfzeile sagt `stopped after <werkbankTimeoutMin> min`. **Grenze:** `$.process.spawn` kennt nur das harte Beenden. Ob `werkbank-relay` vorher noch `POST …/cancel` schafft, hängt davon ab; sonst läuft der Auftrag auf dem Server zu Ende (Vertrag 0002, „Fehler und Grenzen“), und das Ergebnis ist nur im Leitstand abrufbar. Der Regelfall ist daher, dass der Worker selbst nach `--timeout-min` endet (`timed-out`, N37), lange bevor relay abbricht. | 5.2 |
| N46 | **Geprüfte Fassung** (Abschnitt 1): `werkbank-relay` aus `src/Werkbank.Relay` im Werkbank-Repo. Erwartet `--version` mit einer Fassung; relay trägt **`0.1`** als geprüfte Hauptfassung ein. Am echten Programm geprüft ist das noch nicht (W-P2). | 1 |
| N47 | **Gleichzeitige Plätze:** Ein werkbank-Lauf belegt während des Wartens einen Platz von `maxParallel` wie jeder Lauf. | 7 |

### 15.2 Tests (`claude plugin test plugins/relay`)

- **Gefälschtes `werkbank-relay`** in `tests/fakes.ts`, erkannt am Unterbefehl `run` und an `werkbank-relay` im ersten argv-Eintrag. Szenarien: `ok` (done, mit Paket, Branch, Commits, `changedFiles` innerhalb von `owns`, `verify` grün), `red`, `needs-approval`, `timed-out`, `limit`, `failed`, `cancelled`, `write-outside` (`changedFiles` außerhalb von `owns`), `session-moved`, `error-auth`/`error-network`/`error-repo`/`error-budget` (Exit 2 bzw. 0 mit `error`), `not-json` (Text auf stdout), `hang`; stderr-Fortschrittszeilen in jedem Szenario.
- **Rein (`hooks/backends.test.ts`):** argv neu/fortsetzen in fester Reihenfolge, ohne Modell und Listen, `--timeout-min` bei `0` weggelassen, unsichere Session-ID → kein `--session`, Protokoll-Datei absolut und nicht in argv, Abweisungen aus N32; `parse` für jeden Zustand, jede Fehlerart, Exit ≠ 0 ohne `error`, kein JSON, unsichere `sessionId`.
- **Mit Fake (`tests/werkbank.test.ts`):** Paketstatus je Zustand (N37), Ersatz-Paket `partial` ohne Worker-Paket, Branch unter `needs_from_main` (N40), Schreibprüfung über `changedFiles` mit Verstoß und Projekt im Unterordner (N39), kein lokaler Schnappschuss, Prüfzeile unter `facts` (N38), Session-Wechsel (N41), `~`-Auflösung der Token-Datei, Standard-Timeout 60 min statt `runTimeoutMin` (über `mock.clock`), stderr in `live.log` (N43), Protokoll-Datei nach dem Lauf leer.

### 15.3 Plan

| Nr. | Schritt | Marke |
|---|---|---|
| W-P1 | Nachtrag 2 abnehmen | [braucht Nutzer/Unreal/Hardware] |
| W-P2 | Backend, Einstellungen, Fake, Tests nach 15.1 und 15.2; README und Skill `relay-orchestrator` um werkbank ergänzen; Fassung 0.5.0 | [Claude-prüfbar] |
| W-P3 | Echter Lauf mit dem gebauten `werkbank-relay.exe` gegen den Leitstand: Fassung (N46), JSON-Felder wie im Fake, Abbruch bei Timeout (N45) | [braucht Nutzer/Unreal/Hardware] |

**Stand 18. November 2026:** W-P1 erledigt (abgenommen), W-P2 in relay 0.5.0 gebaut und mit `claude plugin test plugins/relay` geprüft (neue Datei `tests/werkbank.test.ts`, reine Fälle in `hooks/backends.test.ts`). Offen ist W-P3. Ein unterbrochener werkbank-Lauf (Neustart des Plugins) wird wie jeder andere als `interrupted` gemeldet; seine Schreibprüfung findet keinen Schnappschuss und heißt `incomplete` (bisheriges Verhalten aus 7.2, unverändert; ersetzt durch N53).

### 15.4 Nachtrag 2a (18. November 2026): Befunde aus dem Codex-Review von `8121e9e`

**Status: abgenommen am 18. November 2026** (N48–N57 wie vorgeschlagen). Ein Codex-Review (gpt-6.2-sol) von relay 0.5.0 fand 10 Befunde (5 hoch, 4 mittel, 1 niedrig). „Befund“ nennt die Nummer im Review (H = hoch, M = mittel, L = niedrig).

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N48 | **Kein `done` trotz Fehler.** Ein Exit-Code ≠ 0 ist bei werkbank immer ein Fehler, auch mit `jobId` und `state: done`; ein `error` im JSON ebenso (Art nach N35). Bei `state: done` macht ein solcher Fehler aus `done` ein `partial`, `risks` sagt `werkbank-relay reported an error (<art>): <meldung>`. Ein JSON **ohne** `jobId` ist immer ein Fehler (`cli`, „werkbank-relay reported no jobId“), auch mit Antwort; ein Paket darin wird höchstens `partial` (Regel N26). | N34, N35, N36 | H1 |
| N49 | **Schreibprüfung nur mit sicherer Grundlage.** (a) Scheitert `git rev-parse --show-prefix`, ist die Prüfung `incomplete` („project prefix unknown“), statt still die Repo-Wurzel anzunehmen. (b) `changedFiles` muss eine Liste nicht leerer Zeichenketten sein; sonst ist die Prüfung `incomplete` („the werkbank job reported a malformed file list“), nichts gilt als geprüft. (c) Pfade werden als POSIX-Pfade verglichen, `\` wird nicht in `/` umgeschrieben. Ein absoluter Pfad oder einer mit einem `..`-Teil zählt immer als außerhalb, egal was `owns` sagt. | N39 | H2 |
| N50 | **Einstellungen in `argv` werden geprüft.** `werkbankLeitstand` wird als URL gelesen: nur `http:`/`https:`, **ohne** Benutzer oder Passwort; die Ablehnung nennt den Wert nicht. Der Pfad zur Token-Datei muss nach dem Auflösen von `~` absolut sein und darf nicht mit `-` beginnen. Sonst startet der Lauf nicht (N32). | N32, N44 | H3 |
| N51 | **`live.log` über Zeilen hinweg bereinigt (alle Backends).** Beginnt eine Zeile einen privaten Schlüssel (`-----BEGIN … PRIVATE KEY-----`), ersetzt relay alles bis einschließlich `-----END … PRIVATE KEY-----` durch eine Zeile `[redacted private key]`, auch über Stücke von stdout/stderr hinweg. Fehlt das Ende, bleibt alles Weitere des Laufs ausgeblendet. | N2, N43, 9 | H4 |
| N52 | **Temp-Dateien selbst geprüft (opencode und werkbank).** Vor dem Schreiben der Aufgaben- bzw. Protokoll-Datei prüft relay die Datei selbst wie ihren Ordner (N17): Ist sie ein Link oder löst sie nicht genau auf ihren Platz auf, startet der Lauf nicht („Worker was not started: …“); beim Leeren nach dem Lauf wird erneut geprüft und eine solche Datei nicht beschrieben. **Grenze:** `$.fs` kennt weder exklusives Anlegen noch „Links nicht folgen“ (V3); zwischen Prüfung und Schreiben bleibt ein kurzes Fenster. | N17, N25, N31 | H5 |
| N53 | **Wiederaufnahme nach Neustart (werkbank).** relay leert auch `<rolle>-<lauf>.protocol.md` (mit der Prüfung aus N52). Die Schreibprüfung eines unterbrochenen werkbank-Laufs ist `incomplete` mit dem Grund „the werkbank job may still be running on the server; its changes would be on agent/relay/<rolle>“, statt einen nicht vorhandenen lokalen Schnappschuss zu suchen. | 7.2, N13, N25 | M1 |
| N54 | **Endzustände einheitlich (N37 präzisiert).** Ist `state` nicht `done`, ruft relay den Ersatz-Verdichter **nicht** auf: Fehlt ein Paket des Workers, gibt es das Ersatz-Paket (`partial`, bei `failed`/`cancelled` `failed`); die Antwort steht wie immer vollständig in `full.md`. Die Zeile `werkbank job <id> ended <state>: <grund>` steht **immer** unter `risks`, auch im Ersatz-Paket. Grund bei `red`: zuerst die Prüfzeile aus N38, dahinter, falls vorhanden, `error.message`. | N37 | M2 |
| N55 | **Session bleibt, wo sie gilt.** Eine geänderte `isolation` verwirft die Session einer werkbank-Rolle nicht (werkbank nutzt sie nicht, N33). „Session moved“ (N41) vergleicht mit der ID, die wirklich als `--session` mitging; ging keine mit, gibt es keinen solchen Hinweis. | N23, N33, N41 | M3 |
| N56 | **Berichtigung von N34:** „ein Paket entsteht dann nicht“ ist falsch formuliert. Wie bei allen Backends meldet relay ein `failed`-Paket mit der bereinigten Meldung (`kind: cli`); es entsteht nur kein Paket **aus der Antwort**. Das Verhalten bleibt, wie gebaut. | N34 | M4 |
| N57 | **Test der Live-Anzeige:** Die Fälschung gibt Fortschrittszeilen aus und wartet dann; der Test prüft `live.log`, während der Lauf noch einen Platz belegt und ein zweiter Auftrag (`maxParallel: 1`) wartet. | 15.2 | L1 |

**Tests:** je Zeile mindestens ein Fall, der mit `8121e9e` fehlschlägt (außer N56, nur Text); reine Fälle in `hooks/backends.test.ts`, die übrigen in `tests/werkbank.test.ts`; N51 und N52 zusätzlich für codex bzw. opencode. Fassung bleibt 0.5.0 (noch nicht veröffentlicht).

**Stand 18. November 2026:** N48–N57 gebaut. `claude plugin test plugins/relay`: 146 bestanden, 0 fehlgeschlagen. Gegenprobe: die 11 neuen Fälle in `tests/werkbank.test.ts` schlagen mit `8121e9e` fehl. `live.log` wird jetzt nach der Uhr der Plugin-API gebündelt (statt `Date.now()`), damit N57 ohne echtes Warten prüfbar ist; die Regel „höchstens alle 2 Sekunden“ bleibt.

### 15.5 Nachtrag 2b (18. November 2026): Befunde aus dem zweiten Codex-Review (`c270e77...61f3313`)

**Status: abgenommen am 18. November 2026** (N58–N67 wie vorgeschlagen). Das zweite Codex-Review (gpt-6.2-sol) fand 10 Befunde (5 hoch, 4 mittel, 1 niedrig).

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N58 | **Keine Zugangsdaten in werkbank-`argv`.** `werkbankLeitstand` muss wörtlich mit `http://` oder `https://` beginnen und darf weder Benutzer/Passwort noch Query (`?…`) noch Fragment (`#…`) haben. Jeder Wert für `--model`, `--allowed-tools`, `--disallowed-tools` und `--owns`, den die Bereinigung (N2, N18) verändern würde, wird abgelehnt; der Lauf startet nicht (N32). Die Meldung nennt nur die Option, nie den Wert. | N32, N50 | H1 |
| N59 | **Prefix immer frisch.** Für die Schreibprüfung eines werkbank-Laufs fragt relay `git rev-parse --show-prefix` im Projektordner **immer** ab, unabhängig von der git-Probe vor dem Start. Scheitert die Abfrage, ist die Prüfung `incomplete` (N49). | N49 | H2 |
| N60 | **Wörtliche Pfade beim Vergleich mit dem Server.** Vom git-Prefix wird nur das Zeilenende entfernt (kein `trim`). Prefix, `changedFiles` und `owns` werden nicht umgeschrieben (kein `\` → `/`); von `owns` fallen nur ein führendes `./` und abschließende `/` weg. `owns` einer werkbank-Rolle schreibt man daher mit `/`. | N49 | H3 |
| N61 | **Kein Erfolg ohne bestätigten Exit-Code.** `ProcessResult` bekommt `signal?: string` und `streamError?: string`. Endet der Prozess durch ein Signal oder scheitert das Lesen seiner Ausgabe (nicht durch Timeout oder Token-Grenze), ist das bei codex, opencode und werkbank ein Fehler (`cli`, „ended by signal …“ bzw. „reading the output failed: …“). werkbank verlangt für ein unbeschränktes `done` zusätzlich Exit-Code `0`; ohne Exit-Code wird `done` zu `partial` (N48). claude bleibt unverändert (3.1). | 2.1 `ProcessResult`, N26, N48 | H4 |
| N62 | **Schlüsselfilter liest jede Zeile ganz.** Der Filter aus N51 geht alle `BEGIN`/`END`-Marken einer Zeile der Reihe nach durch. Bleibt am Zeilenende ein Schlüssel offen, wird die Zeile durch `[redacted private key]` ersetzt und alles bis zum passenden `END` ausgeblendet. Vollständige Blöcke innerhalb einer Zeile bleiben Sache der Bereinigung (N2). | N51 | H5 |
| N63 | **`live.log` ohne hängende Zeilen.** Kommt eine Zeile innerhalb der 2 Sekunden nach dem letzten Schreiben, plant relay genau ein Nachschreiben zum Ende dieser 2 Sekunden (Uhr der Plugin-API). Schreibvorgänge laufen nacheinander. | 9, N57 | M1 |
| N64 | **Token-Datei mit eindeutigem Pfad.** Auf Windows (`OS = Windows_NT`) muss der Pfad ein Laufwerk (`C:\…`, `C:/…`) oder eine UNC-Freigabe (`\\server\freigabe\…`) haben; sonst ein POSIX-Pfad ab `/`. Ein Pfad ohne Laufwerk wie `\Users\…` wird unter Windows abgelehnt. | N50 | M2 |
| N65 | **Fehlerart und Hinweis bleiben beide.** Fehlt bei einer Antwort die `jobId`, nennt die Meldung das immer (`… (werkbank-relay reported no jobId)`); die Art kommt aus `error.kind`, falls vorhanden, sonst `cli`. Bei Endzuständen mit Grund steht die Art aus N35 in der Endzeile: `werkbank job <id> ended limit (budget): <grund>`. | N35, N48, N54 | M3 |
| N66 | **Nur echte Commit-IDs.** Aus `commits` nimmt relay nur Einträge der Form `^[0-9a-f]{7,64}$` (ohne Rücksicht auf Groß-/Kleinschreibung). Andere zählt es und meldet unter `risks` `werkbank reported <n> malformed commit id(s) (not shown)`, ohne sie zu zeigen. | N40 | M4 |
| N67 | **Die mitgegebene Session meldet das Backend.** `Invocation` bekommt `sessionArg?: string`: die Session-ID, die `build` dem Programm wirklich übergeben hat. „Session moved“ (N55) vergleicht damit statt `argv` zu durchsuchen. | 2.1 `Invocation`, N55 | L1 |

**Tests:** je Zeile mindestens ein Fall, der mit `61f3313` fehlschlägt; N59 mit einem git, das schon **vor** dem Start scheitert; N61 für werkbank und codex; N62 mit zwei Schlüsseln in einer Zeile; N63 mit einem Lauf, dessen ganzer Fortschritt in den ersten 2 Sekunden kommt. Fassung bleibt 0.5.0.

**Stand 18. November 2026:** N58–N67 gebaut. `claude plugin test plugins/relay`: 156 bestanden, 0 fehlgeschlagen; `claude plugin test .`: 314 bestanden. Gegenprobe mit `61f3313`: die neuen Integrationsfälle (N59, N61, N63, N64, N66) schlagen fehl; N58, N60, N62, N65, N67 sind reine Fälle in `hooks/backends.test.ts`, die neue Schnittstellen nutzen. N61 für codex ist ein reiner Fall (`parse` mit `signal`).

### 15.6 Nachtrag 2c (18. November 2026): Befunde aus dem dritten Codex-Review (`c270e77...9e02c5e`)

**Status: abgenommen am 18. November 2026** (N68–N72 und die Grenzen wie vorgeschlagen). Das dritte Codex-Review (gpt-6.2-sol) fand 10 Befunde (4 hoch, 5 mittel, 1 niedrig). Entschieden vom Nutzer am 18. November 2026: nur die echten beheben, den Rest als Grenzen festhalten.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N68 | **`live.log` gehört dem laufenden Lauf.** Beim Abschluss eines Laufs (`close`) verfällt ein noch geplantes Nachschreiben (N63); nach `close` schreibt dieser Lauf nichts mehr. Die Schreibvorgänge aller Läufe einer Rolle laufen nacheinander, sodass ein alter Lauf den Kopf eines neuen nie überschreibt. | N63, 9 | M1 |
| N69 | **Ein unbrauchbares `error` ist ein Fehler.** Ist `error` im JSON vorhanden, aber kein Objekt, gilt das als Protokollfehler (`cli`, „werkbank-relay sent a malformed error field“); `done` wird dann `partial` (N48). Die Fehlerart wird nur aus eigenen Schlüsseln der Tabelle in N35 gelesen; jede andere Angabe (auch `constructor` o. Ä.) ist `unknown`. | N35, N48 | H4 |
| N70 | **Das Ende muss zum Anfang passen.** Der Schlüsselfilter (N51, N62) merkt sich die Art des offenen Schlüssels (`RSA`, `OPENSSH`, `EC`, leer …); nur ein `END` derselben Art beendet die Ausblendung. | N51, N62 | M2 |
| N71 | **Abbruch vor dem JSON richtig benennen.** Liefert `werkbank-relay` kein JSON und endet durch ein Signal oder einen Lesefehler, nennt der Fehler das (N61) statt stderr. Der Hinweis „could not start …; set <id>Bin …“ erscheint nur, wenn weder stdout noch stderr etwas enthalten und es weder Exit-Code noch Signal gibt. | N34, N61, 2.5 | M5 |
| N72 | **Keine Session-ID, die nach Zugangsdaten aussieht.** Eine Session-ID, die die Bereinigung (N2) verändern würde, übernimmt relay nicht aus der Antwort und gibt sie beim Fortsetzen nicht mit (der Lauf beginnt neu). | N1, N34, N41 | H2 |

**Festgehaltene Grenzen (nicht behoben):**
- **H1:** Werte, die `build` später als Zugangsdaten ablehnt (N58), stehen vorher schon wörtlich in der Rolle (`$.store`) und in `queue.json`/`queue.json.bak`, wie jeder Auftrag (N2). Zugangsdaten gehören nicht in Rollen-Angaben.
- **H3:** relay entfernt Leerzeichen am Anfang und Ende von `owns`-Einträgen (`toList`), auch für werkbank. Pfade, die mit Leerzeichen beginnen oder enden, lassen sich so nicht besitzen.
- **M3:** Scheitert die Prüfung, ob eine Temp-Datei existiert (`$.fs.exists` wirft), gilt sie als nicht vorhanden. Ein hängender Link (Ziel fehlt) wird von `$.fs.exists` nicht sicher erkannt.
- **M4:** Antwortet `werkbank-relay` ohne `jobId` mit Text ohne Paket und ist der Ersatz-Verdichter aus, steht der Hinweis „reported no jobId“ nur in `full.md` und der Kopfzeile (`error (…)`), nicht in der Zusammenfassung.
- **L1:** Unter Windows lässt die Prüfung aus N64 Gerätepfade (z. B. benannte Pipes `\\.\pipe\…`) als UNC-Pfad durch. Die Einstellung setzt der Nutzer selbst.

**Tests:** je Zeile N68–N72 mindestens ein Fall, der mit `9e02c5e` fehlschlägt; N68 mit zwei schnell aufeinander folgenden Läufen derselben Rolle.

**Stand (18. November 2026):** N68–N72 umgesetzt. `claude plugin test plugins/relay`: 164 pass, 0 fail; die 8 neuen Fälle (4 rein, 4 Integration) schlagen mit `9e02c5e` fehl (156 pass, 8 fail). N71: die Ursache (Signal, Lesefehler) steht vorn, stderr folgt als Kontext wie in N61.

### 15.7 Nachtrag 2d (19. November 2026): Befunde aus dem vierten Codex-Review (`c270e77...e6966a6`)

**Status: abgenommen am 19. November 2026** (N73–N80 wie vorgeschlagen). Das vierte Codex-Review (gpt-6.2-sol) fand 8 Befunde (2 hoch, 5 mittel, 1 niedrig). Entschieden vom Nutzer am 19. November 2026: die echten beheben. Alle acht werden als echt eingestuft.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N73 | **Der Paketstatus ist Text.** `status` im Paket zählt nur, wenn es ein Text aus `done`, `partial`, `blocked`, `failed` ist; alles andere (auch `["done"]`) wird `partial`. Damit greifen alle Abstufungen (Schreibprüfung, Fehler, Zeitlimit, rote Jobs) sicher. Gilt für alle Backends. | 4 (Paket), N48 | hoch 1 |
| N74 | **Auch im ganzen Text endet ein Schlüssel nur an seinem eigenen Ende.** Die Bereinigung (N2) blendet einen privaten Schlüssel vom `BEGIN` bis zum `END` derselben Art aus; fehlt dieses Ende, bis zum Ende des Textes. Gilt für `full.md`, Paket, Fehlermeldungen und alles andere, was `redact` durchläuft. | N2, N70 | hoch 2 |
| N75 | **Temp-Datei: geprüft wird, was geschrieben wird.** Der Prüfpfad unter `<relayDir>/tmp/` wird aus dem letzten Teil des Pfads nach `/` oder `\` gebildet, auch wenn der Pfad Zeilenumbrüche enthält. | N52 | mittel 1 |
| N76 | **Token-Datei ohne Zugangsdaten im Pfad.** Ein `werkbankTokenFile`, das die Bereinigung (N2) nach dem Auflösen von `~` verändern würde, wird abgelehnt („werkbankTokenFile looks like it contains a credential; it is not passed on.“); der Wert wird nicht genannt, der Lauf startet nicht. | N50, N58, N64 | mittel 2 |
| N77 | **Auch `error: null` ist unbrauchbar.** Steht der Schlüssel `error` im JSON, gilt jeder Wert außer einem Objekt (auch `null`) als Protokollfehler wie in N69. Fehlt der Schlüssel, ist das kein Fehler. | N69 | mittel 3 |
| N78 | **Eine abgelehnte neue Session löscht die alte.** Meldet `werkbank-relay` eine Session-ID, die relay nach N72 nicht übernimmt, behält die Rolle auch die alte nicht; der nächste Lauf beginnt neu. Das Paket nennt das unter `risks` („werkbank reported a session id relay does not keep; the next task for <role> starts a fresh session.“). | N41, N72 | mittel 4 |
| N79 | **Der eigene Testlauf von relay braucht relay.** Im Lauf `claude plugin test plugins/relay` schlägt ein Test fehl, wenn relay nicht geladen ist; im Lauf über das ganze Repo wird er sichtbar übersprungen statt still bestanden. Kann die Testvorrichtung die beiden Läufe nicht unterscheiden, wird das hier als Grenze nachgetragen und gemeldet. | 10.1 | mittel 5 |
| N80 | **werkbank-Pfade bleiben beim Zusammenführen wörtlich.** Fügt relay die Schreibprüfung eines werkbank-Jobs ins Paket ein, vergleicht es die Artefakte des Workers mit den gemeldeten Dateien wörtlich (kein `\` → `/`, wie in N60); lokale Backends bleiben unverändert. | N39, N60 | niedrig 1 |

**Tests:** je Zeile N73–N80 mindestens ein Fall, der mit `e6966a6` fehlschlägt (N79: der Test selbst ist der Nachweis; geprüft wird, dass er ohne geladenes relay im eigenen Lauf rot wird). N73 mit einem Schreibverstoß und `"status":["done"]`; N74 mit Paket und Fehlermeldung; N78 nach einer zuvor gültigen Session.

**Grenze zu N79 (nachgetragen am 19. November 2026, wie in N79 vorgesehen):** Die Testvorrichtung lässt die beiden Läufe nicht unterscheiden. Geprüft mit einer Probe in beiden Läufen: Im Lauf über das Repo lädt relay nicht, registriert nichts und fragt nichts ab, also genau das Bild eines relay, das nicht lädt. Der Testkit kennt weder Umgebung noch Arbeitsordner noch Plugin-Namen (`process` fehlt, `$.config.describe` ist im Test nicht nutzbar), und `hooks.json` lässt sich im Test nicht einlesen (nur Code-Dateien). N79 bleibt deshalb offen: Fehlt relay im eigenen Lauf, bestehen die Integrationsfälle weiterhin still.

**Stand (19. November 2026):** N73–N78 und N80 umgesetzt, N79 als Grenze oben. `claude plugin test plugins/relay`: 173 pass, 0 fail; mit `e6966a6` schlagen 10 Fälle fehl (163 pass, 10 fail): 7 reine Fälle (N73, N74, N75, N76, N78, N80 sowie der um N77 erweiterte N69-Fall) und 3 Integrationsfälle (N73, N74, N78). Der Dateiname für die Temp-Prüfung kommt jetzt aus `baseName` in `protocol.ts`.

### 15.8 Nachtrag 2e (19. November 2026): Befunde aus dem fünften Codex-Review (`c270e77...0a087d9`)

**Status: abgenommen am 19. November 2026** (N81–N86 wie vorgeschlagen). Das fünfte Codex-Review (gpt-6.2-sol) fand 6 Befunde (3 hoch, 2 mittel, 1 niedrig). Entschieden vom Nutzer am 19. November 2026: die echten beheben. Fünf werden behoben; einer (mittel 1) widerspricht der abgenommenen Lesart von N65 und wird klargestellt statt geändert.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N81 | **Die Warteschlange liefert nur gültige Rollen und Läufe.** Beim Laden von `queue.json` (und `.bak`) verwirft relay Aufträge, deren Rolle nicht dem Muster für Rollennamen entspricht (`a-z`, `0-9`, `-`, `_`, höchstens 32 Zeichen) oder deren Laufnummer vorhanden, aber keine positive ganze Zahl ist; die Zahl der verworfenen Aufträge steht in einem Hinweis. Beim Leeren einer Temp-Datei schreibt relay genau den Pfad, den es geprüft hat (`<relayDir>/tmp/<name>`). | 7.2, N21, N52, N53 | hoch 1 |
| N82 | **Kein Argument für werkbank-relay, das nach Zugangsdaten aussieht.** Jedes Argument, das relay an `werkbank-relay` gibt, auch `--cwd`, `--protocol-file` und die Teile von `werkbankBin`, wird gegen die Bereinigung (N2) geprüft. Würde sie es verändern, startet der Lauf nicht; die Meldung nennt nur das Feld („a value for --cwd looks like a credential; it is not passed on.“ bzw. `werkbankBin`). Mit einem solchen `werkbankBin` läuft auch die Versionsprüfung nicht. | N58, N76 | hoch 2 |
| N83 | **Der Schlüsselfilter liest auch den entschlüsselten Text.** Für `live.log` prüft der Filter (N51, N62, N70) bei JSON-Zeilen die rohe Zeile und zusätzlich alle Texte des Ereignisses nach dem Entschlüsseln (z. B. `-` → `-`), vor jedem Kürzen. Gilt für codex, opencode und werkbank. | N51, N62, N70 | hoch 3 |
| N84 | **Klarstellung zu N65 (keine Änderung).** Der Hinweis „werkbank-relay reported no jobId“ gilt für Antworten mit Text (`answer`). Eine Ausgabe nur mit `error` ist die in Vertrag 0002 vorgesehene Form „das Programm selbst konnte nicht arbeiten“; dort entstand kein Job, und die Meldung bleibt die Fehlermeldung allein. | N65 | mittel 1 |
| N85 | **JSON-Fehler und Prozessfehler bleiben beide.** Enthält das JSON einen Fehler und endet der Prozess zusätzlich durch ein Signal oder einen Lesefehler, behält die Meldung die Art aus dem JSON und hängt den Prozessfehler an („<meldung> · ended by signal SIGTERM“ bzw. „· reading the output failed: …“). | N48, N61 | mittel 2 |
| N86 | **Unterbrochene werkbank-Läufe zeigen die unvollständige Prüfung in der Kopfzeile.** Der Bericht nach einem Neustart (N53) trägt wie ein laufender Bericht `⚠ write check incomplete`. | N10, N53 | niedrig 1 |

**Tests:** je Zeile N81–N83, N85, N86 mindestens ein Fall, der mit `0a087d9` fehlschlägt; N81 mit einem Auftrag für die Rolle `../../docs/release` und einer Datei außerhalb von `<relayDir>/tmp`, die unverändert bleiben muss; N83 mit maskierten Marken in getrennten codex-Ereignissen.

**Stand (19. November 2026):** N81–N83, N85, N86 umgesetzt, N84 als Klarstellung. `claude plugin test plugins/relay`: 181 pass, 0 fail; mit `0a087d9` schlagen die 8 neuen Fälle fehl (173 pass, 8 fail): 4 reine (N81, N82, N83, N85) und 4 Integrationsfälle (N81, N82, N83, N86). Das Muster für Rollennamen (`ROLE_NAME`) liegt jetzt in `queue.ts`. N86 gilt für jeden unterbrochenen Lauf: auch lokale Backends tragen `⚠ write check incomplete` bzw. `⚠ wrote outside owns` in der Kopfzeile, wie ein laufender Bericht (N10).

### 15.9 Nachtrag 2f (19. November 2026): Befunde aus dem sechsten Codex-Review (`c270e77...ca161c6`)

**Status: abgenommen am 19. November 2026** durch den Auftrag des Nutzers „Nachtrag 2f direkt umsetzen“ (ohne eigene Vorlage vorab). Das sechste Codex-Review (gpt-6.2-sol) fand 7 Befunde (2 hoch, 3 mittel, 2 niedrig); alle werden behoben.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N87 | **Maskierte Schlüssel-Marken zählen wie echte.** Die Bereinigung (N2, N74) und der Zeilenfilter (N51, N70) erkennen die Marken auch, wenn ihre Bindestriche JSON-maskiert sind (`-`, `-`). Ein ganzer maskierter Schlüssel in einer Zeile wird so in `live.log`, `full.md`, Paket, Nachricht und Fehlermeldungen ausgeblendet. | N2, N74, N83 | hoch 1 |
| N88 | **`live.log` selbst wird geprüft.** Vor jedem Schreiben prüft relay die Datei `<relayDir>/runs/<rolle>/live.log` wie ihren Ordner (N17). Ist sie ein Link oder zeigt sie aus dem Projekt, schreibt relay für diesen Lauf kein `live.log` mehr und nennt das einmal unter `risks`. | N17, N52 | hoch 2 |
| N89 | **Der Prozessfehler aus N85 bleibt in jedem Endzustand sichtbar.** Bei `failed` und `cancelled` nennt das Paket neben dem Grund auch den Fehler aus `parse` (mit dem Prozessfehler). Bei Teilzuständen (`red`, `needs-approval`, `timed-out`, `limit`) stehen der Grund in der Endzeile (N54, N65) und der Prozessfehler als `cli`-Fehler unter `risks` (N48), beide sichtbar. | N48, N85 | mittel 1 |
| N90 | **Eine leere Job-ID ist keine.** Eine `jobId` aus nur Leerzeichen gilt als fehlend (N48, N65). | N48, N65 | mittel 2 |
| N91 | **Eine mitgeschickte, unbrauchbare Session-ID verwirft die alte.** Steht `sessionId` in der Antwort, ist aber kein brauchbarer Text (auch `""` oder kein Text), gilt N78. Fehlt der Schlüssel, bleibt es bei N78s Verhalten für „keine Session gemeldet“. | N78 | mittel 3 |
| N92 | **Auch der nachgereichte Bericht behält seine Kopfzeile.** relay speichert die Kopfzeile in `packet.json`; ein nach einem Neustart zugestellter gespeicherter Bericht nutzt sie (mit dem Zusatz „delivered after a restart“), statt „finished“ und ohne Warnungen. | N86, 7.2 | niedrig 1 |
| N93 | **Die Zahl der verworfenen Aufträge stimmt.** N81 zählt jeden Auftrag, der wegen seiner Rolle (auch einer, die kein Text ist) oder seiner Laufnummer verworfen wird. | N81 | niedrig 2 |

**Tests:** je Zeile N87–N93 mindestens ein Fall, der mit `ca161c6` fehlschlägt; N87 mit einer werkbank-stderr-Zeile ohne JSON auf stdout (geprüft: `live.log`, `packet.json`, Nachricht).

**Stand (19. November 2026):** N87–N93 umgesetzt. `claude plugin test plugins/relay`: 189 pass, 0 fail; mit `ca161c6` schlagen die 8 neuen Fälle fehl (181 pass, 8 fail): 4 reine (N87, N90, N91, N93) und 4 Integrationsfälle (N87, N88, N89, N92). `packet.json` trägt jetzt das Feld `head`. Vor dem Bericht wartet relay, bis die anstehenden `live.log`-Schreibvorgänge des Laufs durch sind, damit ein Problem aus N88 noch unter `risks` steht.

### 15.10 Nachtrag 2g (19. November 2026): Befunde aus dem siebten Codex-Review (`c270e77...b02d68b`)

**Status: abgenommen am 19. November 2026** (N94–N98 wie vorgeschlagen). Das siebte Codex-Review (gpt-6.2-sol) fand 5 Befunde (2 hoch, 2 mittel, 1 niedrig). Entschieden vom Nutzer am 19. November 2026: alles beheben, auch die Schlüsselvarianten.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N94 | **Schlüssel werden nach dem Entschlüsseln gesucht, ersetzt wird im Original.** Die Bereinigung (N2) sucht private Schlüssel in einer Lesart des Textes, in der alle JSON-Maskierungen (`\uXXXX`, `\n`, `\"`, `\\`, `\/` …) aufgelöst sind, gleich welches Zeichen maskiert ist. Der gefundene Bereich wird im Originaltext ausgeblendet (vom Anfang der Marke bis zum Ende der passenden Marke, sonst bis zum Textende). Das ersetzt die Sonderregel aus N87 und gilt für alles, was `redact` durchläuft: `live.log`, `full.md`, Paket, Nachricht, Fehlermeldungen. Der Zeilenfilter (N51, N70) sucht seine Marken ebenso in der entschlüsselten Lesart. | N2, N74, N87 | hoch 1 |
| N95 | **Ein über mehrere Felder verteilter Schlüssel bleibt verborgen.** Beim Bereinigen eines Pakets (und von `packet.json`) liest relay alle Texte in ihrer Reihenfolge wie einen Strom: Öffnet ein Text einen Schlüssel, ohne ihn zu schließen, werden die folgenden Texte bis einschließlich des Textes mit dem passenden Ende durch `[redacted private key]` ersetzt. | N2, N74 | hoch 2 |
| N96 | **`live.log` ist fertig, bevor der Bericht geht.** relay schreibt das letzte `live.log` (Endzeile) vor dem Bericht und nimmt ein Problem aus N88 noch in dessen `risks` auf. | N68, N88 | mittel 1 |
| N97 | **Ein nachgereichter Bericht gehört zu seinem Lauf.** Beim Speichern legt relay die fertige Nachricht zusätzlich unter `<relayDir>/runs/<rolle>/undelivered-<lauf>.md` ab; diese Datei wird nicht rotiert und nach der Zustellung geleert. Ein Neustart stellt sie zu. Fehlt sie, wird `packet.json` nur genutzt, wenn dessen `run` und `backend` zum Auftrag passen; sonst meldet relay den Lauf als unterbrochen mit dem Hinweis „the stored report was overwritten by a later run (keepRuns)“. | N15, N92, 7.2 | mittel 2 |
| N98 | **README zur Timeout-Warnung.** Die README nennt die Regel richtig: `worker_status` warnt, wenn beide Grenzen gesetzt sind und `werkbankTimeoutMin` nicht über `runTimeoutMin` liegt. | N44 | niedrig 1 |

**Tests:** je Zeile N94–N97 mindestens ein Fall, der mit `b02d68b` fehlschlägt; N94 mit einem maskierten Buchstaben in der Marke (in `live.log` und in einer Fehlermeldung); N95 mit Anfang, Inhalt und Ende in drei `risks`-Einträgen (Paket und Nachricht); N97 mit `keepRuns: 1`, zwei Läufen und gescheiterter Zustellung des ersten.

**Stand (19. November 2026):** N94–N98 umgesetzt. `claude plugin test plugins/relay`: 194 pass, 0 fail; mit `b02d68b` schlagen die 5 neuen Integrationsfälle fehl (189 pass, 5 fail): N94, N95, N96 und zweimal N97. Der N97-Fall bildet den Zustand nach der gescheiterten Zustellung direkt nach: Lauf 2 belegt den Platz von Lauf 1, der noch auf die Zustellung wartet. Reine Fälle mit wörtlichen Schlüssel-Marken in `backends.test.ts` hat Secret Guard gestoppt; sie fehlen, die Integrationsfälle nutzen die Platzhalter aus `tests/fakes.ts`. `undelivered-<lauf>.md` entsteht bei jeder Speicherung und bleibt nach der Zustellung als leere Datei liegen (relay kann über `$.fs` nicht löschen). `redactDeep` liest die Texte jetzt als Strom (N95); N87s Sonderregel ist durch N94 ersetzt.

### 15.11 Nachtrag 2h (19. November 2026): Befunde aus dem achten Codex-Review (`c270e77...040be1f`)

**Status: abgenommen am 20. November 2026** (N99–N106 wie vorgeschlagen). Das achte Codex-Review (gpt-6.2-sol) fand 8 Befunde (3 hoch, 3 mittel, 2 niedrig); vier davon gehen auf Nachtrag 2g zurück. Entschieden vom Nutzer am 19. November 2026: alles beheben.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N99 | **Jede Berichtsdatei wird selbst geprüft.** Beim Speichern prüft relay jede Zieldatei (`full.md`, `packet.json`, `undelivered-<lauf>.md`) unmittelbar vor dem Schreiben wie ihren Ordner (N17). Ist eine davon ein Link oder zeigt aus dem Projekt, schreibt relay sie nicht; die Nachricht nennt das wie bisher („Not stored: …“). | N17, N97 | hoch 1 |
| N100 | **Paket in der Reihenfolge des Workers bereinigen.** relay bereinigt das Paket des Workers (N95) in der Reihenfolge, in der seine Felder im JSON stehen, bevor es die Felder ordnet. | N95 | hoch 2 |
| N101 | **`live.log` zeigt kein Ereignis mit Schlüssel-Marke und keinen Fehlertext bei offenem Schlüssel.** Enthält ein Ereignis (roh oder entschlüsselt, in irgendeinem Feld) eine `BEGIN … PRIVATE KEY`-Marke, steht statt der Zeile `[redacted private key]`, auch wenn der Schlüssel im selben Ereignis endet. Ist beim Abschluss noch ein Schlüssel offen, enthält die Endzeile keinen Fehlertext, nur „error (text hidden: a private key is open)“. | N51, N70, N83, N94 | hoch 3 |
| N102 | **Ein unterbrochener Lauf schreibt nicht in einen fremden Platz.** Meldet relay einen Lauf als unterbrochen, weil ein späterer Lauf seinen Platz belegt (N97), schreibt es weder `full.md` noch `packet.json`; nur die Nachricht geht hinaus. | N97 | mittel 1 |
| N103 | **Der gespeicherte Bericht trägt die Job-ID.** `undelivered-<lauf>.md` beginnt mit der Zeile `<!-- relay job <id> -->`. Beim Neustart prüft relay für jeden laufenden Auftrag (auch ohne `delivery: stored`) zuerst diese Datei; passt die Job-ID, stellt es ihren Inhalt zu (ohne die Kennzeile), statt den Lauf als unterbrochen zu melden. Eine Datei mit fremder oder fehlender ID wird nicht zugestellt. | N15, N97 | mittel 2 |
| N104 | **Ein gescheitertes Schreiben von `live.log` wird genannt.** Scheitert ein Schreibvorgang von `live.log` (z. B. Platte voll), gilt das wie ein Problem aus N88 und steht unter `risks`. | N88, N96 | mittel 3 |
| N105 | **Auch die gespeicherte Nachricht trägt den Zusatz.** Stellt relay `undelivered-<lauf>.md` nach einem Neustart zu, endet ihre erste Zeile mit „ · delivered after a restart“ (N92). | N92, N97 | niedrig 1 |
| N106 | **codex und opencode: Fehler-Ereignis und Prozessfehler bleiben beide.** Meldet codex oder opencode ein Fehler-Ereignis und endet der Prozess zusätzlich durch ein Signal oder einen Lesefehler, behält der Fehler seine Art und bekommt den Prozessfehler angehängt („<meldung> · ended by signal …“), wie N85 für werkbank. | N61, N85 | niedrig 2 |

**Tests:** je Zeile N99–N106 mindestens ein Fall, der mit `040be1f` fehlschlägt; N99 mit einem Link an `undelivered-<lauf>.md` (das Ziel bleibt unberührt); N100 mit Anfang in `decisions`, Inhalt in `summary`, Ende in `risks`; N102 mit der Prüfung, dass die Dateien von Lauf 2 erhalten bleiben; N103 mit einem laufenden Auftrag ohne `delivery: stored`. Wörtliche Schlüssel-Marken nur über die Platzhalter in `tests/fakes.ts`.

**Stand (20. November 2026):** N99–N106 umgesetzt. `claude plugin test plugins/relay`: 204 pass, 0 fail; mit `040be1f` schlagen die 10 neuen Integrationsfälle fehl (194 pass, 10 fail): je einer für N99, N100, N102, N104, N105, N106 und je zwei für N101 (drei Felder eines Ereignisses; offener Schlüssel am Ende) und N103 (laufender Auftrag ohne `delivery: stored`; fremde Job-ID). Der N97-Fall aus 2g legt seine Datei jetzt mit Kennzeile an. Ein gescheitertes `live.log`-Schreiben steht als „live.log was not written: the write failed (…)“ unter `risks`. Die Nachricht eines unterbrochenen Laufs mit belegtem Platz nennt statt eines Pfades „(not stored: a later run holds this slot)“. Eine Kennzeile ist nur gültig, wenn sie genau `<!-- relay job <id> -->` lautet.

### 15.12 Nachtrag 2i (20. November 2026): Befunde aus dem neunten Codex-Review (`c270e77...8846165`)

**Status: abgenommen am 20. November 2026** (N107–N113 wie vorgeschlagen). Das neunte Codex-Review (gpt-6.2-sol) fand 7 Befunde (4 hoch, 1 mittel, 2 niedrig); fünf davon gehen auf Nachtrag 2g/2h zurück. Entschieden vom Nutzer am 20. November 2026: die echten beheben. Alle sieben werden als echt eingestuft.

| Nr. | Änderung | Ersetzt / ergänzt | Befund |
|---|---|---|---|
| N107 | **Ein Schlüssel über Strom-Grenzen erreicht weder Paket noch Nachricht.** (a) relay bereinigt die ganze Antwort (Fließtext und Paket als ein Text), bevor es das Paket herausliest; zerstört das Ausblenden das Paket, gilt die Antwort als eine ohne Paket (Ersatz-Kompression über die bereinigte Antwort). (b) Enthält irgendein Ausgabetext des Laufs (stderr, Antwort, Fehlermeldung, Grund des werkbank-Jobs) eine `BEGIN … PRIVATE KEY`-Marke, roh oder entschlüsselt, gibt relay die Fehlermeldung, den Grund und den stderr-Auszug nirgends weiter; an ihrer Stelle steht „(text hidden: the run's output contains a private key marker)“. Fehlerart und Status bleiben. | N2, N94, N101 | hoch 1 |
| N108 | **Berichtsdateien werden vor dem Lesen geprüft.** Bevor relay `full.md`, `packet.json` oder `undelivered-<lauf>.md` liest (`worker_expand`, Neustart), prüft es die Datei wie vor dem Schreiben (N99). Ist sie ein Link oder zeigt aus dem Projekt, liest relay sie nicht: `worker_expand` antwortet „relay does not read … (<Grund>)“, der Neustart meldet den Lauf als unterbrochen (ohne Dateien, wie N102) mit dem Grund unter `risks`. Was `worker_expand` ausgibt, ist bereinigt, bevor ein Abschnitt herausgesucht oder gekürzt wird. | N17, N99, N103 | hoch 2 |
| N109 | **Die Nachricht wird nach den Speicher-Hinweisen bereinigt.** relay bereinigt die fertige Nachricht erst, nachdem alle „Not stored: …“-Hinweise angehängt sind, und speichert und versendet nur diese Fassung. | N2, N99 | hoch 3 |
| N110 | **Kein Schreiben in einen Platz, den ein späterer Lauf hält.** Unmittelbar vor jedem Schreiben von `full.md` oder `packet.json` (erster Versuch, Wiederholung, Neustart mit oder ohne `delivery: stored`) prüft relay, ob ein späterer Lauf derselben Rolle den Platz schon belegt (keepRuns). Dann schreibt es dort nichts, und die Nachricht sagt „Not stored: a later run holds this slot“. `undelivered-<lauf>.md` ist nicht rotiert und wird weiter geschrieben. Zwischen Prüfung und Schreiben bleibt ein kurzes Fenster (wie N52). | N97, N102 | hoch 4 |
| N111 | **Eine unvollständige gespeicherte Nachricht wird nicht zugestellt.** Die Kennzeile von `undelivered-<lauf>.md` nennt die Länge der Nachricht: `<!-- relay job <id> length <n> -->` (n = Zeichen nach der Kennzeile). Stimmt die Länge beim Neustart nicht, gilt die Datei als fehlend: relay nutzt `packet.json` (bei `delivery: stored`, mit N97/N108) oder meldet den Lauf als unterbrochen. | N103 | mittel 1 |
| N112 | **`worker_status` zeigt „worktree“ nur, wo es gilt.** Bei einem Backend, das `isolation` nicht anwendet (werkbank), fehlt „· worktree“; „ignored: isolation“ bleibt. | N33 | niedrig 1 |
| N113 | **N106 für beide Backends und beide Prozessfehler getestet.** Reine Tests für codex und opencode, je mit Signal und mit Lesefehler, prüfen Fehlerart und angehängte Meldung. | N106 | niedrig 2 |

**Tests:** je Zeile N107–N112 mindestens ein Fall, der mit `8846165` fehlschlägt; N107 mit `key-open-error` (Prüfung von `packet.json` und Nachricht) und mit einer Antwort, deren Schlüssel im Fließtext öffnet und im Paket weitergeht; N108 mit einem Link an `001.full.md` (`worker_expand`) und an `packet.json` (Neustart); N110 mit `keepRuns: 1`, gescheitertem Schreiben von `undelivered-1.md`, fertigem Lauf 2 und Wiederholung von Lauf 1 (die Dateien von Lauf 2 bleiben). Wörtliche Schlüssel-Marken nur über die Platzhalter in `tests/fakes.ts`.

**Stand (20. November 2026):** N107–N113 umgesetzt. `claude plugin test plugins/relay`: 213 pass, 0 fail; `claude plugin test .`: 371 pass, 0 fail. Mit `8846165` schlagen 10 Fälle fehl (203 pass, 10 fail): je zwei für N107 und N108, je einer für N109, N110 und N112 sowie die drei Fälle aus 2g/2h (N97, N103, N105), deren gespeicherte Nachricht jetzt die Länge in der Kennzeile trägt; nur die neue Fassung stellt diese Dateien zu. Sie sind die Gegenprobe für N111. Der eigene N111-Fall (Länge stimmt nicht) und der reine N113-Test bestehen auch mit `8846165`: Die alte Fassung lehnt die neue Kennzeile ohnehin ab, und N113 schließt nur eine Testlücke. Ein unterbrochener Lauf ohne nutzbare Dateien nennt statt eines Pfades „(not stored: <Grund>)“, etwa „a later run holds this slot“ oder „its stored files are not safe to use“.
