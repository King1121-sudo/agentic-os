/**
 * Shared text utilities for the memory subsystem (Phase 5).
 * Lives apart from memory.ts so the vector drivers can import embed/cosine
 * without a circular module dependency. memory.ts re-exports these — the
 * historical import sites (tests, tools) keep working.
 */

const STOPWORDS = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of', 'in',
  'on', 'for', 'with', 'and', 'or', 'not', 'it', 'this', 'that', 'i', 'you', 'my', 'me', 'do', 'does',
  'did', 'have', 'has', 'had', 'will', 'would', 'can', 'could', 'should', 'at', 'as', 'by', 'from', 'what', 'how']);

export function tokenize(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{1,}/g) ?? [])
    .filter(t => !STOPWORDS.has(t) && t.length > 2);
}

/** Deterministic bag-of-hashes embedding (dim 128). Not semantic — but stable,
 *  dependency-free, and good enough for term-overlap similarity. A real
 *  embedding provider (vector.ts) slots in without touching any caller. */
export function embed(text: string): number[] {
  const v = new Array(128).fill(0);
  for (const tok of tokenize(text)) {
    let h = 2166136261;
    for (let i = 0; i < tok.length; i++) { h ^= tok.charCodeAt(i); h = Math.imul(h, 16777619); }
    v[Math.abs(h) % 128] += 1;
  }
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map(x => x / norm);
}

export function cosine(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i];
  return s;
}

/** ~4 chars per token — cheap consistent estimate for working-memory bounds. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
