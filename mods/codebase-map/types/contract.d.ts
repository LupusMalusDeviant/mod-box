export type BlueprintStatus =
  | { kind: 'fresh'; head: string }
  | { kind: 'behind'; head: string; stamp: string; commits: number; files: number }
  | { kind: 'unknown-stamp'; head: string; stamp: string }
  | { kind: 'no-stamp'; head: string }

export type MapFeature = {
  slug: string
  name: string
  summary: string
  files: string[]
  deps: string[]
  // Pfad-Globs aus dem INDEX-Abschnitt "Zuordnung"; leer bei älteren Blueprints.
  globs: string[]
}

// Spiegelung nach Confluence (publish-on-confluence): Opt-in im INDEX-Frontmatter, Seiten-ID nach dem ersten Publish.
export type MapConfluence = { isOptedIn: boolean; pageId: string | null }

export type MapData = { features: MapFeature[]; confluence: MapConfluence }

export type MapActivity = {
  id: string
  slug: string | null
  file: string
  agentId: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'codebase-map': {
      status: BlueprintStatus | null
      dismissedAt: string | null
      map: MapData | null
      selected: string | null
      active: MapActivity[]
      touched: { [slug: string]: string[] }
      unassigned: string[]
    }
  }
}
