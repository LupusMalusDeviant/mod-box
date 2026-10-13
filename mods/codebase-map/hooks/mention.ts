// Mod Box addition: features in the prompt. Typing @ and part of a feature name offers its
// blueprint (the engine then attaches it like any @file), and a mentioned code file gets one line
// naming the feature it belongs to and where its blueprint is. No $ here.
import type { MapData } from '../types'
import { BLUEPRINT_DIR, featureOf } from './blueprint'
import type { Lang } from './i18n'

const MAX_SUGGESTIONS = 8

export const blueprintPath = (slug: string) => `${BLUEPRINT_DIR}/${slug}.md`

/** Typeahead rows for a token like "@auth": the features whose name or slug contains the rest. */
export function featureSuggestions(map: MapData, token: string, lang: Lang) {
  if (!token.startsWith('@')) return []
  const q = token.slice(1).toLowerCase()
  // A path being typed is the engine's own business.
  if (/[/\\.]/.test(q)) return []
  return map.features
    .filter(f => q === '' || f.name.toLowerCase().includes(q) || f.slug.includes(q))
    .sort((a, b) => Number(!a.name.toLowerCase().startsWith(q)) - Number(!b.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
    .slice(0, MAX_SUGGESTIONS)
    .map(f => ({
      text: `@${blueprintPath(f.slug)}`,
      label: `@${f.name}`,
      description: `${lang === 'de' ? 'Blueprint' : 'blueprint'}${f.summary ? `: ${f.summary}` : ''}`.slice(0, 120),
    }))
}

/** One line for the model when a mentioned file belongs to a mapped feature; null otherwise. */
export function mentionHint(map: MapData, rel: string, lang: Lang): string | null {
  if (rel.startsWith(`${BLUEPRINT_DIR}/`)) return null
  const slug = featureOf(map, rel)
  const f = slug === null ? undefined : map.features.find(one => one.slug === slug)
  if (!f) return null
  const deps = f.deps.length ? (lang === 'de' ? ` Hängt ab von: ${f.deps.join(', ')}.` : ` Depends on: ${f.deps.join(', ')}.`) : ''
  return lang === 'de'
    ? `[Codebase Map] ${rel} gehört zum Feature „${f.name}“${f.summary ? `: ${f.summary}` : ''}.${deps} Blueprint: ${blueprintPath(f.slug)} (vor größeren Änderungen lesen).`
    : `[Codebase Map] ${rel} belongs to the feature "${f.name}"${f.summary ? `: ${f.summary}` : ''}.${deps} Blueprint: ${blueprintPath(f.slug)} (read it before larger changes).`
}
