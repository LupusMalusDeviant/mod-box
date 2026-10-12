import type { Lang } from './i18n'

export const START = '<!-- codebase-map:start -->'
export const END = '<!-- codebase-map:end -->'

const LINES: Record<Lang, string[]> = {
  de: [
    '## Codebase-Blueprint',
    '',
    '`docs/blueprints/INDEX.md` beschreibt den Feature-Schnitt dieser Codebase. Damit nur den Code lesen, den eine Aufgabe betrifft:',
    '',
    '- Zuerst `INDEX.md` lesen. Über die Pfade im Abschnitt „Zuordnung“ das Ziel-Feature bestimmen und nur dessen `docs/blueprints/<feature>.md` lesen, keine weiteren Feature-Dateien.',
    '- Folgen einer Änderung über die Tabelle „Kanten (geprüft)“ bestimmen: eingehende Kanten zum Ziel-Feature verfolgen, eine zweite Stufe nur über Kanten, deren Spalte „via“ ein geändertes Symbol oder eine geänderte Route nennt. Statt fremder Feature-Dateien die Beleg-Stellen der Kanten öffnen.',
    '- Code nur unter den Pfaden der betroffenen Features öffnen. Breit suchen nur, wenn dort nichts passt.',
    '- „Unberührt“ nur melden, wenn keine Kante irgendeiner Art zum Ziel führt, auch keine HTTP-Kante. Wer eine API über HTTP anspricht (CLI, Web-Client, Partner), ist betroffen, sobald sich das Verhalten hinter dieser API ändert.',
    '- Aussagen darüber, wer etwas aufruft („die UI nutzt Endpoint X“), erst nach einer Suche nach den Aufrufern im Code treffen; dass eine Methode existiert, heißt nicht, dass sie genutzt wird.',
    '- Die Kanten sind maschinell aus dem Code ermittelt. Verhaltensaussagen im Fließtext sind Hinweise; für Verhalten ist der Code maßgeblich, Abweichungen nennen.',
    '- Fehlen „Zuordnung“ oder „Kanten (geprüft)“ (älterer Blueprint), den Blueprint nur zur Orientierung nutzen und Abhängigkeiten im Code prüfen.',
    '- Subagenten, die den Code erkunden, diese Hinweise mitgeben.',
    '- Den Blueprint pflegt der Mod `codebase-map` („aktualisiere den Blueprint“ oder `/codebase-map update`). Dokumentationssprache des Blueprints: Deutsch.',
    '',
    '_Dieser Block wird vom Mod `codebase-map` gepflegt und entfernt, sobald dessen CLAUDE.md-Pflege abgeschaltet wird._',
  ],
  en: [
    '## Codebase blueprint',
    '',
    '`docs/blueprints/INDEX.md` describes how this codebase splits into features. Use it to read only the code a task touches:',
    '',
    '- Read `INDEX.md` first. Find the target feature through the paths in the "Mapping" section and read only its `docs/blueprints/<feature>.md`, no other feature files.',
    '- Work out the impact of a change from the "Edges (verified)" table: follow the incoming edges of the target feature, and go a second step only along edges whose "via" column names a changed symbol or route. Open the edge evidence lines instead of other feature files.',
    '- Open code only under the paths of the affected features. Search broadly only when nothing fits there.',
    '- Report a feature as unaffected only when no edge of any kind leads to the target, HTTP edges included. Whoever calls an API over HTTP (CLI, web client, partners) is affected as soon as the behaviour behind that API changes.',
    '- Make claims about who calls something ("the UI uses endpoint X") only after searching the code for the callers; a method that exists is not necessarily used.',
    '- The edges are extracted from the code by a script. Statements about behaviour in the prose are hints; for behaviour the code is authoritative, so point out differences.',
    '- If "Mapping" or "Edges (verified)" is missing (older blueprint), use the blueprint for orientation only and check dependencies in the code.',
    '- Pass these hints on to subagents that explore the code.',
    '- The `codebase-map` mod maintains the blueprint ("update the blueprint" or `/codebase-map update`). Blueprint documentation language: English.',
    '',
    "_This block is maintained by the `codebase-map` mod and removed as soon as its CLAUDE.md upkeep is switched off._",
  ],
}

export const blockFor = (lang: Lang) => [START, ...LINES[lang], END].join('\n')

// Liefert den neuen Inhalt oder null, wenn nichts zu ändern ist; ein Block in anderer Sprache wird ersetzt.
export const withBlock = (current: string | null, lang: Lang = 'de'): string | null => {
  const block = blockFor(lang)
  if (current === null) return `${block}\n`
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const ownBlock = block.replace(/\n/g, eol)
  const start = current.indexOf(START)
  const end = current.indexOf(END)
  if (start >= 0 && end > start) {
    const next = current.slice(0, start) + ownBlock + current.slice(end + END.length)
    return next === current ? null : next
  }
  const base = current.replace(/\s*$/, '')
  return `${base}${base === '' ? '' : eol + eol}${ownBlock}${eol}`
}

// Entfernt den Block samt der Leerzeilen davor; null, wenn keiner da ist. Bleibt nichts übrig, ist das Ergebnis ''.
export const withoutBlock = (current: string | null): string | null => {
  if (current === null) return null
  const start = current.indexOf(START)
  const end = current.indexOf(END)
  if (start < 0 || end < start) return null
  const eol = current.includes('\r\n') ? '\r\n' : '\n'
  const before = current.slice(0, start).replace(/\s*$/, '')
  const after = current.slice(end + END.length).replace(/^\s*/, '').replace(/\s*$/, '')
  const rest = [before, after].filter(part => part !== '').join(eol + eol)
  return rest === '' ? '' : rest + eol
}
