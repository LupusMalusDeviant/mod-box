# relay

Ein Claude-Code-Plugin, mit dem **ein Main-Agent mehrere eigenständige Sessions als Worker steuert**, z. B. einen *Ingester*, einen *Architekten* und einen *Researcher*, die parallel am selben Wiki oder Projekt arbeiten. Jede Rolle wählt ihr **Backend**: Claude Code (`claude`, Standard), Codex CLI (`codex`) oder OpenCode (`opencode`, darüber auch Ollama- und OpenRouter-Modelle).

Du redest nur mit dem Main-Agent. Er verteilt Aufgaben an die Worker. Die Worker melden ihre Ergebnisse als kompaktes **Relay-Paket** zurück: kurz, aber ohne dass Entscheidungen, Dateiänderungen, Blocker oder exakte Angaben (Zahlen, Pfade, URLs, Versionen) verloren gehen. Die vollständigen Antworten liegen auf der Platte und werden nur bei Bedarf nachgeladen. So bleibt der Kontext des Main-Agents klein.

## Wie es funktioniert

```
            Du
             │
        Main-Agent ──── worker_send ────► ingester   (eigene Session, eigener Kontext)
             ▲     ──── worker_send ────► architect
             │     ──── worker_send ────► researcher
             │
             └──── Relay-Pakete ◄──────── alle Worker
                   (Volltext in .relay/runs/…, abrufbar mit worker_expand)
```

- **Rolle**: ein Worker mit Namen, Aufgabenbeschreibung (*brief*) und eigenem Schreibbereich (*owns*). Eine Rolle behält ihre Session über viele Aufgaben hinweg und erinnert sich an frühere Läufe.
- **Lauf**: eine Aufgabe für eine Rolle. Er läuft im Hintergrund als `claude -p`, `codex exec` oder `opencode run`. Der Main-Agent arbeitet währenddessen weiter. Was der Lauf gerade tut, steht in `.relay/runs/<rolle>/live.log`.
- **Schreibprüfung**: Nach jedem Lauf vergleicht relay den git-Stand mit dem vor dem Lauf, für alle Backends gleich. Schreibt ein Worker außerhalb seiner `owns`, wird `done` zu `partial`, der Pfad steht unter den Risiken und die Kopfzeile trägt `⚠ wrote outside owns (n)`. Die Prüfung meldet nur, sie macht nichts rückgängig.
- **Warteschlange**: Wartende Aufträge liegen in `.relay/queue.json` und überstehen einen Neustart des Plugins.
- **Relay-Paket**: das Ergebnis eines Laufs. Es enthält Status, Zusammenfassung, Entscheidungen, Fakten, geänderte Dateien, offene Fragen, was der Main-Agent tun oder entscheiden muss, Risiken und nächste Schritte.
- **Ergebnisse laufen immer über den Main-Agent.** Worker sprechen nie direkt miteinander. Damit ist klar, wer was weiß und wer was entscheidet.

## Die drei Werkzeuge des Main-Agents

| Werkzeug | Wozu |
|---|---|
| `worker_send` | Gibt einer Rolle eine Aufgabe. Startet sofort oder reiht sie in die Warteschlange ein. |
| `worker_status` | Zeigt, welche Rolle arbeitet, wartet oder fertig ist, und was zuletzt rauskam. |
| `worker_expand` | Holt Details zu einem Paket: einen Abschnitt, das ganze Paket oder den Volltext. |

Der mitgelieferte Skill **`relay-orchestrator`** bringt dem Agent bei, wann und wie er diese Werkzeuge einsetzt. Du musst ihm nur sagen, was du erreichen willst, z. B.: *„Lass den Ingester diese 10 Links verarbeiten, und der Architekt soll danach prüfen, ob wir neue Tags brauchen.“*

## Einstellungen

Einstellbar in der Mod Box unter ⚙ oder mit `/plugin configure relay@<marketplace>`.

### Worker starten

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Default backend** (`defaultBackend`) | `claude` | Backend für Rollen ohne eigene Angabe: `claude`, `codex` oder `opencode`. |
| **Claude executable** (`claudeBin`) | `claude` | Das Programm, mit dem claude-Worker gestartet werden. Nur ändern, wenn `claude` nicht im PATH liegt, z. B. ein vollständiger Pfad zu `claude.exe`. Auch als JSON-Liste aus Programm und festen Argumenten möglich, z. B. `["node", "C:/…/cli.js"]`. |
| **Codex executable** (`codexBin`) | `codex` | Wie oben für codex. Unter Windows ist das `codex` aus npm ein `.cmd`-Starter, der ohne Shell nicht läuft: den vollständigen Pfad zu `codex.exe` eintragen (liegt unter `npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/`). |
| **Codex sandbox** (`codexSandbox`) | `workspace-write` | Betriebssystem-Sperre für codex: `workspace-write` schreibt nur im Arbeitsordner, ohne Netz (also auch kein `git push`). `read-only` schreibt gar nicht. Ganz ohne Sandbox startet relay codex nie. |
| **OpenCode executable** (`opencodeBin`) | `opencode` | Wie oben für opencode; unter Windows der Pfad zu `opencode.exe`. |
| **OpenCode standalone** (`opencodeStandalone`) | an | Jeder opencode-Lauf bekommt einen eigenen Server. Nur so beendet ein Timeout auch die Arbeit. |
| **Worker permission mode** (`permissionMode`) | `acceptEdits` | Was Worker ohne Rückfrage dürfen. Worker können dich **nicht** fragen. `acceptEdits`: Dateien bearbeiten ja, riskante Befehle werden abgelehnt. `plan`: nur planen, nichts ändern. `default`: alles, was eine Freigabe bräuchte, wird abgelehnt. `bypassPermissions`: alles erlaubt, nur in einer Sandbox nutzen. |
| **Worker model** (`workerModel`) | `claude-sonnet-5-5` | Das Modell, mit dem claude-Worker standardmäßig laufen. Leer heißt: das Standardmodell der CLI. Pro Rolle überschreibbar, z. B. Haiku für einen einfachen Ingester. Für codex und opencode gibt die Rolle ihr Modell selbst an; opencode braucht die Form `anbieter/modell`, z. B. `ollama/kimi-k3:cloud`. |
| **Worker effort** (`workerEffort`) | `medium` | Wie gründlich Worker nachdenken. Höher heißt besser, aber langsamer und teurer. `default` übernimmt die Einstellung der CLI. Pro Rolle überschreibbar. |

### Kosten und Grenzen

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Budget per run (USD)** (`maxBudgetUsd`) | `2` | Höchstbetrag pro claude-Lauf. Ist er erreicht, bricht der Worker ab und meldet `partial`. `0` = keine Grenze. |
| **Token limit per run** (`maxTokensPerRun`) | `0` | Nur codex und opencode, die keinen Betrag durchsetzen: relay zählt die Token mit und stoppt den Lauf, sobald Ein- plus Ausgabe-Token die Grenze überschreiten (kann um einen Zug darüber gehen). `0` = keine Grenze. |
| **Parallel workers** (`maxParallel`) | `3` | Wie viele Worker gleichzeitig laufen. Weitere Aufgaben warten und starten von selbst, sobald ein Platz frei wird. |
| **Timeout per run (minutes)** (`runTimeoutMin`) | `30` | Ein Lauf, der länger dauert, wird beendet und als `partial` oder `failed` gemeldet. `0` = kein Timeout. |

### Sicherheit

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Allowed tools** (`allowedTools`) | leer | Werkzeuge, die Worker ohne Rückfrage nutzen dürfen, durch Komma getrennt, z. B. `Read, Grep, WebFetch, Bash(git status:*)`. Pro Rolle überschreibbar. |
| **Disallowed tools** (`disallowedTools`) | `Bash(git push:*)` | Werkzeuge, die Worker nie nutzen dürfen, z. B. `Bash(git push:*), Bash(rm:*)`. Pro Rolle überschreibbar. |
| **Enforce ownership** (`enforceOwns`) | an | Ein claude-Worker darf nur in seinen eigenen Pfaden (*owns*) Dateien anlegen oder ändern. Andere Schreibversuche werden blockiert, und der Worker meldet stattdessen, was geändert werden müsste. Gilt für die Werkzeuge Edit, Write und NotebookEdit. Schreiben über die Shell erfasst der Wächter **nicht**; das fängt die Schreibprüfung nachträglich auf. |
| **Write check** (`writeCheck`) | `report` | Vergleicht nach jedem Lauf den git-Stand mit dem davor und meldet Schreiben außerhalb von `owns`, auch über die Shell und per Commit, für alle Backends. Braucht ein git-Repo, sonst wird nicht geprüft. Von git ignorierte Dateien sieht die Prüfung nicht. `off` = keine Prüfung. |
| **Default isolation** (`isolation`) | `shared` | `shared`: Rollen arbeiten im Projektordner. `worktree`: jede Rolle in einem eigenen git-Worktree `.relay/worktrees/<rolle>` auf dem Branch `relay/<rolle>`. relay führt nichts zusammen, das Paket nennt den Branch. Nicht eingecheckte Dinge (`node_modules`, `.env`) fehlen im Worktree. Pro Rolle überschreibbar. |

Was ein Backend nicht umsetzen kann (z. B. `allowedTools` bei codex), sagt `worker_send` in seiner Antwort und `worker_status` hinter der Rolle (`· ignored: …`). opencode bekommt `git push` und `Bash(...)`-Verbote als eigene Rechte, codex verlässt sich auf die Sandbox.

### Wie Ergebnisse ankommen

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Packet delivery** (`notifyMode`) | `prompt` | `prompt`: Ein fertiges Paket weckt den Main-Agent sofort, er reagiert von selbst. `note`: Das Paket wird still angehängt, der Agent sieht es bei deiner nächsten Nachricht. Spart Runden, wenn viele Worker gleichzeitig fertig werden. `toast`: Nur eine kurze Einblendung, die Pakete holt sich der Agent über `worker_status`. |
| **Packet detail** (`packetDetail`) | `full` | `full`: Das Paket enthält alles. `lean`: nur das, was eine Reaktion braucht (Status, Zusammenfassung, Entscheidungen, Dateien, offene Fragen). Fakten, Risiken und nächste Schritte werden nur gezählt und bei Bedarf nachgeladen. Noch kleinerer Kontext. |
| **Fallback compression** (`fallbackCompress`) | an | Vergisst ein Worker sein Paket, baut ein günstiges Modell es aus der Antwort nach. Aus: Der Lauf wird als `failed` gemeldet, der Volltext bleibt lesbar. |
| **Fallback compressor backend** (`fallbackBackend`) | `claude` | Wer das fehlende Paket baut: `claude` (das Modell darunter), `ollama` (das Ollama-Modell als lokaler Prozess) oder `off`. Scheitert Ollama, gibt es kein Paket; relay weicht nicht von selbst auf Claude aus. |
| **Fallback compressor model** (`fallbackModel`) | `claude-haiku-5-5` | Das Claude-Modell für diesen Ersatz. Kostet nur, wenn ein Paket fehlt. |
| **Ollama model** (`ollamaModel`) | leer | Das Modell für den Ollama-Ersatz, z. B. `qwen3:8b`. Leer wirkt wie `off`. Achtung: Cloud-Modelle (`…:cloud`) schicken die Antwort genauso vom Rechner weg wie Claude; für lokal erst `ollama pull <modell>`. |
| **Ollama executable** (`ollamaBin`) | `ollama` | Das Programm für den Ollama-Ersatz. |

Die Kopfzeile eines Pakets nennt Backend und Verbrauch, z. B. `(claude · 6 turns, $0.42)` oder `(codex · gpt-5.5-codex · 48.2k in (31.0k cached) / 3.1k out tokens)`. `worker_status` zeigt die Summe je Rolle.

### Ablage

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Relay folder** (`relayDir`) | `.relay` | Projektordner für die Volltexte (`runs/`), die Warteschlange (`queue.json`), Hilfsdateien (`tmp/`), Worktrees (`worktrees/`) und die Rollen-Datei. |
| **Roles file** (`rolesFile`) | `.relay/roles.json` | Datei mit fest definierten Rollen (siehe unten). Sie gehört ins Repository. |
| **Ignore run files in git** (`gitignore`) | an | Trägt in Git-Projekten `.relay/runs/`, `queue.json`, `queue.json.bak`, `tmp/` und `worktrees/` in die `.gitignore` ein. Die Rollen-Datei bleibt versioniert. |
| **Runs kept per role** (`keepRuns`) | `20` | Wie viele Läufe pro Rolle auf der Platte bleiben. Ältere werden überschrieben. `0` = alle behalten. |

## Rollen fest definieren

Statt dem Agent jedes Mal Rolle, Aufgabenbereich und Rechte zu erklären, legst du sie einmal pro Projekt in `.relay/roles.json` fest:

```json
{
  "roles": {
    "ingester": {
      "brief": "Verarbeitet Links und Dokumente zu Quellnotizen. Ändert nie Struktur oder Vorlagen.",
      "owns": ["wiki/sources/"],
      "model": "claude-haiku-5-5",
      "effort": "low",
      "allowedTools": ["Read", "Write", "WebFetch"],
      "disallowedTools": ["Bash"]
    },
    "architect": {
      "brief": "Verantwortet Struktur, Vorlagen, Tags und Verlinkungsregeln des Wikis.",
      "owns": ["wiki/_schema/", "wiki/index.md"],
      "effort": "high"
    },
    "researcher": {
      "brief": "Beantwortet Fragen aus Wiki und Web und schreibt Recherchenotizen.",
      "owns": ["wiki/research/"],
      "backend": "opencode",
      "model": "ollama/kimi-k3:cloud"
    },
    "coder": {
      "brief": "Setzt Änderungen im Quellcode um.",
      "owns": ["src/"],
      "backend": "codex",
      "model": "gpt-5.5-codex",
      "effort": "high",
      "isolation": "worktree"
    }
  }
}
```

Wechselt eine Rolle ihr Backend, verwirft relay ihre alte Session (wie `fresh`) und sagt das.

Reihenfolge, wenn etwas mehrfach angegeben ist: **Angabe beim Auftrag** (`worker_send`) vor **Rollen-Datei** vor **Einstellungen des Plugins**.

Faustregel: **Keine zwei Rollen besitzen denselben Pfad.** Gemeinsame Dateien wie ein Index gehören genau einer Rolle. Die anderen melden Änderungswünsche über den Main-Agent.

## Grenzen

- Worker laufen als Unterprozesse der Session. Wird das Plugin neu geladen oder endet die Session, werden laufende Worker beendet. Sie kommen beim nächsten Start als `interrupted` zurück (mit Schreibprüfung) und werden **nicht** neu gestartet. Wartende Aufgaben bleiben in `.relay/queue.json` und starten wieder. Die Sessions der Rollen bleiben gespeichert, der nächste Auftrag macht mit dem alten Kontext weiter.
- Pro Projekt arbeitet **eine** Claude-Session die Warteschlange ab. Eine zweite Session im selben Projekt liest nur mit; `worker_send` lehnt dort ab. Nach drei Minuten ohne Lebenszeichen der ersten übernimmt die nächste, die startet.
- Worker können dir keine Fragen stellen. Alles, was eine Entscheidung braucht, kommt im Paket unter „Needs from main“ zurück.
- Jeder Lauf ist eine vollständige Session der jeweiligen CLI und kostet entsprechend. Für kurze Recherchen sind normale Subagents günstiger.
- Anmeldung und Anbieter für codex und opencode richtest du in der jeweiligen CLI selbst ein; relay fasst das nicht an.
- Worker haben selbst keine Relay-Werkzeuge und können keine weiteren Worker starten.

## Installation

Das Plugin braucht **keine Mod Box**. Es ist ein eigenständiges Claude-Code-Plugin und nutzt nur die Plugin-API von Claude Code und die CLIs der gewählten Backends (`claude`, wahlweise `codex`, `opencode`, `ollama`, dazu `git` für Schreibprüfung und Worktrees).

**Über eine Mod Box** (als nativ verwaltetes Plugin, weil es einen Skill mitbringt):

```bash
node tools/box.mjs native install relay --dir <pfad-zu-diesem-ordner>
```

**Ohne Mod Box**, dieser Ordner ist selbst ein Marketplace:

```bash
claude plugin marketplace add <pfad-zu-diesem-ordner>
claude plugin install relay@relay
```

**Nur zum Ausprobieren**, für eine einzelne Session:

```bash
claude --plugin-dir <pfad-zu-diesem-ordner>
```

Danach Claude neu starten. Prüfen: Den Agent nach `worker_status` fragen, er sollte „No worker roles yet“ melden.

Wichtig: **Pro Installation nur einmal aktivieren.** Ist das Plugin über zwei Quellen installiert (z. B. zwei Mod Boxen), registrieren beide dieselben Werkzeuge. Schalte nur eine Installation ein.
