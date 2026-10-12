# Feature-Detection & Dependency-Mapping Heuristics

Use these heuristics only when the codebase structure is ambiguous. For well-organized monorepos (Nx, Turborepo, clear feature-folders) the feature boundaries are obvious; skip this file.

## Feature-Detection

A **feature** is a coherent unit of business or technical functionality, not a single file, not the whole repo. Typical size: 3-30 source files.

### Strong signals (use first)

1. **Top-level feature folders**: `src/features/<name>/`, `packages/<name>/`, `apps/<name>/`, `modules/<name>/`. One folder = one feature, usually.
2. **Domain-driven folders**: `src/auth/`, `src/billing/`, `src/orders/`. Each = a feature.
3. **Route groups**: in apps with file-based routing (Next.js, Remix, SvelteKit), top-level route segments often map to features.
4. **Exported bounded contexts**: look at the top-level `index.ts`, `lib.rs`, or `__init__.py`: what does it re-export? Each exported namespace is often a feature.

### Weak signals (use when strong ones are missing)

5. **Co-located tests**: tests grouped under a common describe-block or test-folder hint at feature boundaries.
6. **Shared type bundles**: a `types.ts` or `models/` file bundling types used together suggests a feature.
7. **Entry points**: CLI commands, server routes, event handlers, background workers. Each entry point plus its transitive callees often forms a feature.

### When nothing works

Ask the user directly: "I can't infer clear feature boundaries. Can you name 3-7 features you'd want documented?" Better than guessing and producing 40 near-empty blueprints.

## Dependency-Mapping

For each feature: **internal deps** (other features) and **external deps** (packages).

### Internal

- Scan imports inside the feature's files. Any import that resolves to another feature's folder → internal dep.
- Do not list shared utility folders (`src/utils/`, `src/common/`) as features; they are infrastructure. Mention them only if the feature depends on something substantial from them.

### External

- Read `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod` for the top-level dep list.
- For each feature, filter: which of those packages are actually imported in this feature's files?
- Pin versions only if the version is load-bearing (peer deps, known incompatibilities). Otherwise just the package name.

## Feature-Naming

- Use the folder name if it is clear. `auth/` → "Authentication" or "Authentifizierung".
- Use the blueprint's output language (German by default) and stay consistent across all features.
- Avoid generic names ("Utils", "Helpers", "Core") unless the feature is genuinely infrastructural. If you can't give it a better name, it might not deserve its own blueprint.

## Split vs. Merge

- **Split** a feature if its folder has >30 source files AND two clear sub-responsibilities.
- **Merge** two folders if both are small (<5 files each) AND one is obviously a helper for the other.
- When in doubt: prefer fewer, larger blueprints. 10 features are readable; 40 are not.

## Sanity checks before writing

- Every feature must have a non-trivial **Zweck** you can articulate in one sentence. If it doesn't, reconsider whether it's really a feature.
- Every feature must have at least one entry in **Dateien**. Empty file lists indicate bad boundary detection.
- If two features share >50% of their files, they are the same feature; merge them.
