# relay

Ein Claude-Code-Plugin, mit dem **ein Main-Agent mehrere eigenständige Claude-Code-Sessions als Worker steuert**, z. B. einen *Ingester*, einen *Architekten* und einen *Researcher*, die parallel am selben Wiki oder Projekt arbeiten.

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
- **Lauf**: eine Aufgabe für eine Rolle. Er läuft im Hintergrund als `claude -p`. Der Main-Agent arbeitet währenddessen weiter.
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
| **Claude executable** (`claudeBin`) | `claude` | Das Programm, mit dem Worker gestartet werden. Nur ändern, wenn `claude` nicht im PATH liegt, z. B. ein vollständiger Pfad zu `claude.exe`. |
| **Worker permission mode** (`permissionMode`) | `acceptEdits` | Was Worker ohne Rückfrage dürfen. Worker können dich **nicht** fragen. `acceptEdits`: Dateien bearbeiten ja, riskante Befehle werden abgelehnt. `plan`: nur planen, nichts ändern. `default`: alles, was eine Freigabe bräuchte, wird abgelehnt. `bypassPermissions`: alles erlaubt, nur in einer Sandbox nutzen. |
| **Worker model** (`workerModel`) | `claude-sonnet-5-5` | Das Modell, mit dem Worker standardmäßig laufen. Leer heißt: das Standardmodell der CLI. Pro Rolle überschreibbar, z. B. Haiku für einen einfachen Ingester. |
| **Worker effort** (`workerEffort`) | `medium` | Wie gründlich Worker nachdenken. Höher heißt besser, aber langsamer und teurer. `default` übernimmt die Einstellung der CLI. Pro Rolle überschreibbar. |

### Kosten und Grenzen

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Budget per run (USD)** (`maxBudgetUsd`) | `2` | Höchstbetrag pro Lauf. Ist er erreicht, bricht der Worker ab und meldet `partial`. `0` = keine Grenze. |
| **Parallel workers** (`maxParallel`) | `3` | Wie viele Worker gleichzeitig laufen. Weitere Aufgaben warten und starten von selbst, sobald ein Platz frei wird. |
| **Timeout per run (minutes)** (`runTimeoutMin`) | `30` | Ein Lauf, der länger dauert, wird beendet und als `partial` oder `failed` gemeldet. `0` = kein Timeout. |

### Sicherheit

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Allowed tools** (`allowedTools`) | leer | Werkzeuge, die Worker ohne Rückfrage nutzen dürfen, durch Komma getrennt, z. B. `Read, Grep, WebFetch, Bash(git status:*)`. Pro Rolle überschreibbar. |
| **Disallowed tools** (`disallowedTools`) | `Bash(git push:*)` | Werkzeuge, die Worker nie nutzen dürfen, z. B. `Bash(git push:*), Bash(rm:*)`. Pro Rolle überschreibbar. |
| **Enforce ownership** (`enforceOwns`) | an | Ein Worker darf nur in seinen eigenen Pfaden (*owns*) Dateien anlegen oder ändern. Andere Schreibversuche werden blockiert, und der Worker meldet stattdessen, was geändert werden müsste. Gilt für die Werkzeuge Edit, Write und NotebookEdit. Schreiben über die Shell erfasst der Wächter **nicht**, dafür `disallowedTools` nutzen. |

### Wie Ergebnisse ankommen

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Packet delivery** (`notifyMode`) | `prompt` | `prompt`: Ein fertiges Paket weckt den Main-Agent sofort, er reagiert von selbst. `note`: Das Paket wird still angehängt, der Agent sieht es bei deiner nächsten Nachricht. Spart Runden, wenn viele Worker gleichzeitig fertig werden. `toast`: Nur eine kurze Einblendung, die Pakete holt sich der Agent über `worker_status`. |
| **Packet detail** (`packetDetail`) | `full` | `full`: Das Paket enthält alles. `lean`: nur das, was eine Reaktion braucht (Status, Zusammenfassung, Entscheidungen, Dateien, offene Fragen). Fakten, Risiken und nächste Schritte werden nur gezählt und bei Bedarf nachgeladen. Noch kleinerer Kontext. |
| **Fallback compression** (`fallbackCompress`) | an | Vergisst ein Worker sein Paket, baut ein günstiges Modell es aus der Antwort nach. Aus: Der Lauf wird als `failed` gemeldet, der Volltext bleibt lesbar. |
| **Fallback compressor model** (`fallbackModel`) | `claude-haiku-5-5` | Das Modell für diesen Ersatz. Kostet nur, wenn ein Paket fehlt. |

### Ablage

| Einstellung | Standard | Was sie bewirkt |
|---|---|---|
| **Relay folder** (`relayDir`) | `.relay` | Projektordner für die Volltexte (`runs/`) und die Rollen-Datei. |
| **Roles file** (`rolesFile`) | `.relay/roles.json` | Datei mit fest definierten Rollen (siehe unten). Sie gehört ins Repository. |
| **Ignore run files in git** (`gitignore`) | an | Trägt in Git-Projekten `.relay/runs/` in die `.gitignore` ein. Die Rollen-Datei bleibt versioniert. |
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
      "owns": ["wiki/research/"]
    }
  }
}
```

Reihenfolge, wenn etwas mehrfach angegeben ist: **Angabe beim Auftrag** (`worker_send`) vor **Rollen-Datei** vor **Einstellungen des Plugins**.

Faustregel: **Keine zwei Rollen besitzen denselben Pfad.** Gemeinsame Dateien wie ein Index gehören genau einer Rolle. Die anderen melden Änderungswünsche über den Main-Agent.

## Grenzen

- Worker laufen als Unterprozesse der Session. Wird das Plugin neu geladen oder endet die Session, werden laufende Worker beendet und wartende Aufgaben verworfen. Die Sessions der Rollen bleiben aber gespeichert, der nächste Auftrag macht mit dem alten Kontext weiter.
- Worker können dir keine Fragen stellen. Alles, was eine Entscheidung braucht, kommt im Paket unter „Needs from main“ zurück.
- Jeder Lauf ist eine vollständige Claude-Code-Session und kostet entsprechend. Für kurze Recherchen sind normale Subagents günstiger.
- Worker haben selbst keine Relay-Werkzeuge und können keine weiteren Worker starten.

## Installation

Das Plugin braucht **keine Mod Box**. Es ist ein eigenständiges Claude-Code-Plugin und nutzt nur die Plugin-API von Claude Code und die `claude`-CLI.

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
