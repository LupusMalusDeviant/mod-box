// The patterns of known secrets, on their own: Screen Mask uses them too, and a standalone
// export of it then carries only these, not Secret Guard's hooks and state.

// Patterns of known secrets. Kept narrow, so examples and placeholders pass.
export const PATTERNS: Array<[string, RegExp]> = [
  ['Anthropic-API-Key', /sk-ant-[A-Za-z0-9_-]{20,}/g],
  ['OpenAI-API-Key', /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{32,}/g],
  ['GitHub-Token', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})/g],
  ['GitLab-Token', /\bglpat-[A-Za-z0-9_-]{20,}/g],
  ['AWS-Zugangsschlüssel', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['Google-API-Key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Slack-Token', /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ['Stripe-Live-Key', /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/g],
  ['Hugging-Face-Token', /\bhf_[A-Za-z0-9]{30,}/g],
  ['privater Schlüssel', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY(?: BLOCK)?-----/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  [
    'credentials in an assignment',
    /\b(?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret|access[_-]?key)\b["']?\s*[:=]\s*["'](?![^"']*(?:example|beispiel|changeme|placeholder|your[_-]|xxx|<|\$\{|\{\{))[A-Za-z0-9+/_\-.=]{20,}["']/gi,
  ],
]

/** Placeholders and documentation examples: they look like keys but are none. */
export function isPlaceholder(value: string): boolean {
  return /example|dummy|fake|placeholder|redacted|sample|x{6,}|0{10,}|\*{4,}|your[_-]?(?:api|key|token|secret)/i.test(value)
}
