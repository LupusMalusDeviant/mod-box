export type Lang = 'de' | 'en'

export const langOf = (value: unknown): Lang => (value === 'en' ? 'en' : 'de')

const units = {
  de: (commits: number, files: number) =>
    `${commits} ${commits === 1 ? 'Commit' : 'Commits'} / ${files} ${files === 1 ? 'Datei' : 'Dateien'}`,
  en: (commits: number, files: number) =>
    `${commits} ${commits === 1 ? 'commit' : 'commits'} / ${files} ${files === 1 ? 'file' : 'files'}`,
}

// Woran ein Prompt als Blueprint-Auftrag erkannt wird; dann bekommt das Modell den Verweis auf die Anleitung.
export const MAPPER_TRIGGER = /\b(blueprints?|bauplan|baupläne|codebase-map(per)?)\b/i

// Kontext für das Modell, in jeder Sprache Englisch (Anweisungen an Claude bleiben englisch).
export const mapperHint = (dir: string) =>
  `codebase-map: to create, update, check or publish the codebase blueprint (docs/blueprints), first read ${dir}/INSTRUCTIONS.md and follow it. Its references/ and scripts/ live in the same folder (${dir}).`

// Alle sichtbaren Texte und vorbereiteten Prompts; die Prompts werden über MAPPER_TRIGGER als Blueprint-Auftrag erkannt.
export const TEXT = {
  de: {
    paneTitle: 'Codebase-Karte',
    commandDescription: 'Codebase-Karte aus docs/blueprints öffnen',
    commandDone: 'Codebase-Karte geöffnet.',
    behind: (commits: number, files: number, stamp: string) =>
      `Blueprint ist ${units.de(commits, files)} hinter HEAD (Stand ${stamp}).`,
    unknownStamp: (stamp: string) => `Blueprint-Stamp ${stamp} existiert nicht mehr (Rebase?).`,
    noStamp: 'Blueprint hat keinen Commit-Stamp.',
    prepare: 'Prompt vorbereiten',
    map: 'Karte',
    dismiss: 'Ausblenden',
    noBlueprint: 'Kein Blueprint unter docs/blueprints in diesem Projekt.',
    createBlueprint: 'Blueprint erstellen (Prompt vorbereiten)',
    statusNoGit: 'kein Git-Repo',
    statusFresh: 'Blueprint aktuell',
    statusBehind: (commits: number, files: number) => `Blueprint ${units.de(commits, files)} hinter HEAD`,
    statusBadStamp: 'Blueprint ohne gültigen Stamp',
    features: (n: number) => `${n} Features`,
    legend: { active: 'Claude bearbeitet gerade', touched: 'in dieser Session geändert, Blueprint evtl. veraltet', selected: 'ausgewählt' },
    graphAlt: (n: number) => `Abhängigkeitsgraph mit ${n} Features`,
    feature: 'Feature',
    updateFeature: 'Blueprint dieses Features aktualisieren (Prompt vorbereiten)',
    publishFeature: 'Nur dieses Feature in Confluence veröffentlichen (Prompt vorbereiten)',
    publishAll: 'Gesamten Blueprint in Confluence veröffentlichen (Prompt vorbereiten)',
    updateConfluence: 'Confluence aktualisieren (Prompt vorbereiten)',
    editing: (who: 'main' | 'sub', file: string, feature: string | null) =>
      `● ${who === 'main' ? 'Claude' : 'Subagent'} bearbeitet ${file}${feature === null ? '' : ` (${feature})`}`,
    unassigned: (files: string) => `Geändert, keinem Feature zugeordnet: ${files}`,
    confluenceOff: 'Confluence: nicht veröffentlicht',
    confluencePlanned: 'Confluence: vorgesehen, noch keine Seite',
    confluenceOn: (id: string) => `Confluence: gespiegelt (Seite ${id})`,
    uses: 'Benutzt',
    usedBy: 'Benutzt von',
    files: 'Dateien',
    newFile: '(neu, nicht im Blueprint)',
    staleNote: 'In dieser Session geändert: Der Blueprint dieses Features ist vermutlich veraltet.',
    toast: (file: string) => `codebase-map: Blueprint-Verweis in ${file} eingetragen`,
    toastRemoved: (file: string) => `codebase-map: Blueprint-Verweis aus ${file} entfernt`,
    commandUsage: 'Aufruf: /codebase-map [create|update|check|publish]',
    commandPrepared: 'Prompt steht im Eingabefeld; mit Enter absenden.',
    promptCheck: 'ist der Blueprint noch aktuell?',
    promptUpdate: 'aktualisiere den Blueprint',
    promptCreate: 'erstelle einen Blueprint für diese Codebase',
    promptUpdateFeature: (name: string) => `aktualisiere den Blueprint für das Feature "${name}"`,
    promptUpdateConfluence: 'aktualisiere den Blueprint in Confluence',
    promptPublishAll: 'veröffentliche den gesamten Blueprint in Confluence unter <URL der Confluence-Elternseite einfügen>',
    promptPublishFeature: (name: string, isIndexPublished: boolean) =>
      isIndexPublished
        ? `veröffentliche aus dem Blueprint nur das Feature "${name}" in Confluence, unter der bestehenden Index-Seite`
        : `veröffentliche aus dem Blueprint nur die Index-Seite und das Feature "${name}" in Confluence unter <URL der Confluence-Elternseite einfügen>`,
  },
  en: {
    paneTitle: 'Codebase map',
    commandDescription: 'Open the codebase map from docs/blueprints',
    commandDone: 'Codebase map opened.',
    behind: (commits: number, files: number, stamp: string) =>
      `Blueprint is ${units.en(commits, files)} behind HEAD (stamp ${stamp}).`,
    unknownStamp: (stamp: string) => `Blueprint stamp ${stamp} no longer exists (rebase?).`,
    noStamp: 'Blueprint has no commit stamp.',
    prepare: 'Prepare prompt',
    map: 'Map',
    dismiss: 'Hide',
    noBlueprint: 'No blueprint under docs/blueprints in this project.',
    createBlueprint: 'Create a blueprint (prepare prompt)',
    statusNoGit: 'no git repo',
    statusFresh: 'Blueprint up to date',
    statusBehind: (commits: number, files: number) => `Blueprint ${units.en(commits, files)} behind HEAD`,
    statusBadStamp: 'Blueprint without a valid stamp',
    features: (n: number) => `${n} features`,
    legend: { active: 'Claude is editing', touched: 'changed this session, blueprint may be stale', selected: 'selected' },
    graphAlt: (n: number) => `Dependency graph of ${n} features`,
    feature: 'Feature',
    updateFeature: "Update this feature's blueprint (prepare prompt)",
    publishFeature: 'Publish only this feature to Confluence (prepare prompt)',
    publishAll: 'Publish the whole blueprint to Confluence (prepare prompt)',
    updateConfluence: 'Update Confluence (prepare prompt)',
    editing: (who: 'main' | 'sub', file: string, feature: string | null) =>
      `● ${who === 'main' ? 'Claude' : 'Subagent'} is editing ${file}${feature === null ? '' : ` (${feature})`}`,
    unassigned: (files: string) => `Changed, not in any feature: ${files}`,
    confluenceOff: 'Confluence: not published',
    confluencePlanned: 'Confluence: planned, no page yet',
    confluenceOn: (id: string) => `Confluence: mirrored (page ${id})`,
    uses: 'Uses',
    usedBy: 'Used by',
    files: 'Files',
    newFile: '(new, not in the blueprint)',
    staleNote: "Changed in this session: this feature's blueprint is probably stale.",
    toast: (file: string) => `codebase-map: blueprint pointer added to ${file}`,
    toastRemoved: (file: string) => `codebase-map: blueprint pointer removed from ${file}`,
    commandUsage: 'Usage: /codebase-map [create|update|check|publish]',
    commandPrepared: 'The prompt is in the input box; press Enter to send it.',
    promptCheck: 'is the blueprint still up to date?',
    promptUpdate: 'update the blueprint',
    promptCreate: 'create a blueprint for this codebase',
    promptUpdateFeature: (name: string) => `update the blueprint for the feature "${name}"`,
    promptUpdateConfluence: 'update the blueprint in Confluence',
    promptPublishAll: 'publish the whole blueprint to Confluence under <paste the URL of the Confluence parent page>',
    promptPublishFeature: (name: string, isIndexPublished: boolean) =>
      isIndexPublished
        ? `publish only the feature "${name}" of the blueprint to Confluence, under the existing index page`
        : `publish only the index page and the feature "${name}" of the blueprint to Confluence under <paste the URL of the Confluence parent page>`,
  },
} as const

export type Texts = (typeof TEXT)[Lang]
