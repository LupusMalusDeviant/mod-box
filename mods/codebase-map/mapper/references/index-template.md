# Template: INDEX.md

Vorlage für `docs/blueprints/INDEX.md`, die Einstiegsseite des Blueprints.

---

# Codebase-Blueprint

**Repository:** {{REPO_NAME}}
**Generiert:** {{YYYY-MM-DD}}
**Stand (Commit):** {{voller Hash aus `git rev-parse HEAD`, ggf. mit Zusatz "(Working Tree hatte uncommitted Änderungen)", sonst "kein Git-Repo"}}
**Scope:** {{z.B. "Komplettes Repo" oder "src/backend/"}}

## Überblick

{{1 kompakter Absatz: Was macht dieses Repo insgesamt? Für wen? In welchem Stack?}}

## Features

| Feature | Kurzbeschreibung | Blueprint |
|---------|------------------|-----------|
| {{Feature A}} | {{1 Satz}} | [{{feature-a-slug}}.md](./{{feature-a-slug}}.md) |
| {{Feature B}} | {{1 Satz}} | [{{feature-b-slug}}.md](./{{feature-b-slug}}.md) |

## Zuordnung

| Feature | Pfade | Rolle |
|---------|-------|-------|
| [{{Feature A}}](./{{feature-a-slug}}.md) | `{{src/feature-a/**}}` | fach |
| [{{Feature B}}](./{{feature-b-slug}}.md) | `{{src/Services/B*.cs}}`, `{{src/Controllers/BController.cs}}` | fach |
| [{{Verträge}}](./{{vertraege-slug}}.md) | `{{src/Core/**}}` | Vertrag |

Jede Quelldatei gehört zu genau einem Feature; der spezifischste Glob gewinnt. Rolle: `fach`, `Vertrag` (reine Interfaces und Modelle) oder `Querschnitt` (Settings, Audit, Logging).

{{Hier die Ausgabe von `scripts/edges.mjs` einsetzen: Abschnitt "## Kanten (geprüft)" mit Tabelle, Mermaid-Graph und Legende. Nicht von Hand schreiben oder ändern.}}

## Externe Kern-Dependencies

- `{{package-a}}`: genutzt in {{Feature A, Feature C}}
- `{{package-b}}`: genutzt in {{Feature B}}

Nur Packages auflisten, die zentral für mehrere Features sind. Feature-spezifische Deps bleiben in der jeweiligen Feature-.md.

## Wie diese Doku gepflegt wird

Diese Blueprints erzeugt der Mod `codebase-map` (Claude Code).

- Bei Änderungen am Code: „aktualisiere den Blueprint“ oder `/codebase-map update`. Claude vergleicht den Code per `git diff` mit dem Commit-Stamp oben und schreibt nur die betroffenen Features neu.
- Aktualitäts-Check ohne Schreiben: „ist der Blueprint noch aktuell?“ oder `/codebase-map check`. Claude berichtet, welche Features seit dem Stamp veraltet sind.
- Manuelle Ergänzungen in `<feature-slug>.md` bleiben erhalten: unveränderte Features werden nicht angefasst, und beim Neuschreiben eines veralteten Features werden manuelle Abschnitte übernommen.

## Verwandte Doku

- {{Link zu CLAUDE.md, falls vorhanden}}
- {{Link zu README.md, falls substanziell}}
