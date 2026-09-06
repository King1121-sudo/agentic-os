/**
 * Entity extraction (Phase 5) — deterministic, zero-dependency extraction of
 * person/org/tech/url/topic references from memory content, persisted into
 * the existing entities + links graph and the new memory_entities join.
 *
 * Extraction is pattern-driven (capitalized names, known tech vocabulary,
 * URLs, domains) so it works with the builtin deterministic provider and
 * needs no LLM. An LLM-based extractor can be layered later behind the same
 * `extractEntities` signature.
 */
import type { DataPort } from '../infra/types';
import { iso } from '../infra/types';
import type { ExtractedEntity } from '@agentic/contracts';

/** id format in the entities table: "<kind>:<slug>" (matches syncEntity's
 *  `<kind>:<entity_id>` convention). */
export function entityIdFor(kind: string, name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
  return slug || 'unknown';
}

/** Tech vocabulary — a small seeded list keeps this deterministic; entries are
 *  matched case-insensitively as whole words. Extend via TECH_VOCAB.add(). */
const TECH_VOCAB = new Set([
  'postgres', 'postgresql', 'sqlite', 'mysql', 'redis', 'mongodb', 'neo4j',
  'kafka', 'rabbitmq', 'docker', 'kubernetes', 'k8s', 'terraform', 'aws', 'gcp', 'azure',
  'nextjs', 'next.js', 'react', 'vue', 'svelte', 'angular', 'node', 'node.js', 'deno', 'bun',
  'python', 'javascript', 'typescript', 'rust', 'golang', 'go', 'java', 'kotlin', 'swift',
  'fastify', 'express', 'django', 'flask', 'rails', 'spring',
  'openai', 'anthropic', 'claude', 'gpt-4', 'gpt-4o', 'gemini', 'llama', 'mistral', 'ollama',
  'github', 'gitlab', 'bitbucket', 'slack', 'notion', 'linear', 'figma', 'jira',
  'stripe', 'paypal', 'shopify', 'wordpress',
  'pgvector', 'fastapi', 'vite', 'tailwind', 'graphql', 'grpc', 'rest', 'sse',
]);

const STOPNAME = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'for', 'with', 'this', 'that', 'these', 'those',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'monday', 'tuesday', 'wednesday', 'thursday',
  'friday', 'saturday', 'sunday', 'today', 'tomorrow', 'yesterday', 'now', 'there', 'here',
  'user', 'agent', 'system', 'memory', 'phase', 'kernel',
]);

const ORG_MARKERS = new Set(['inc', 'llc', 'ltd', 'gmbh', 'corp', 'corporation', 'company', 'labs', 'technologies', 'systems', 'university', 'institute']);

/** Extract entities from a piece of text. Deterministic, no LLM. */
export function extractEntities(text: string): ExtractedEntity[] {
  const out = new Map<string, ExtractedEntity>();
  const add = (kind: ExtractedEntity['kind'], name: string) => {
    const n = name.trim().replace(/\s+/g, ' ');
    if (!n || n.length < 2 || n.length > 80) return;
    const key = `${kind}:${n.toLowerCase()}`;
    if (!out.has(key)) out.set(key, { kind, name: n });
  };

  // 1) URLs — strongest signal
  const urls = text.match(/https?:\/\/[^\s)"'<>,;]+/gi) ?? [];
  for (const u of urls) {
    let host = u;
    try { host = new URL(u).hostname; } catch { /* keep raw */ }
    add('url', host);
  }
  // bare domains (example.com but not file.ext-ish words)
  const domains = text.match(/\b[a-z0-9][a-z0-9-]*\.(com|org|net|io|dev|ai|app|co|xyz|me)\b/gi) ?? [];
  for (const d of domains) add('url', d.toLowerCase());

  // 2) tech vocabulary (case-insensitive whole-word)
  const lower = ` ${text.toLowerCase().replace(/[^a-z0-9.#-]+/g, ' ')} `;
  for (const t of TECH_VOCAB) {
    if (t.includes('.') || t.includes('-')) {
      if (lower.includes(` ${t} `)) add('tech', t);
    } else if (new RegExp(`\\b${t}\\b`).test(lower)) add('tech', t);
  }

  // 3) people — capitalized bigrams/trigrams not sentence-initial-cliché:
  //    "John Smith" pattern; also "Name" mentioned after titles
  const personPrefix = /(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/g;
  for (const m of text.matchAll(personPrefix)) add('person', m[1]);

  // capitalized multi-word sequences that aren't tech/stop and don't start a sentence cliché
  const capSeq = /\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,}){1,2})\b/g;
  // a lowercase word right after the candidate: signals the candidate is an actor (a name)
  const FOLLOW_VERBS = new Set(['from', 'said', 'says', 'told', 'reported', 'reports', 'presented', 'announced', 'wrote', 'visited', 'called', 'emailed', 'met', 'joined', 'left', 'asked', 'replied', 'noted', 'found', 'confirmed', 'is', 'was', 'has', 'will']);
  for (const m of text.matchAll(capSeq)) {
    const name = m[1].trim();
    const words = name.split(' ');
    // skip all-stopword or known-tech sequences; require 2-3 words, all capitalized
    if (words.length > 3) continue;
    if (words.every(w => STOPNAME.has(w.toLowerCase()))) continue;
    if (words.some(w => TECH_VOCAB.has(w.toLowerCase()))) continue;
    // a sequence ending in an org marker is an ORG, not a person ("Vector Labs Inc")
    const lastWord = words[words.length - 1].toLowerCase();
    if (words.some(w => ORG_MARKERS.has(w.toLowerCase())) || ORG_MARKERS.has(lastWord)) continue;
    // ambiguity guard: a capitalized bigram that OPENS a sentence is usually a
    // subject, not a name — only accept mid-sentence occurrences, UNLESS the
    // next word is a common verb/preposition ("Maria Chen from…" / "… reported")
    const idx = m.index ?? 0;
    const after = text.slice(idx + m[0].length).match(/^\s+([a-z]+)/)?.[1] ?? '';
    const sentenceStart = idx === 0 || /[.!?\n]/.test(text[idx - 1] ?? '');
    if (sentenceStart && !FOLLOW_VERBS.has(after)) continue;
    if (!sentenceStart) {
      const prev = text[idx - 1];
      if (!/[a-z,;:(".\s]/.test(prev ?? ' ')) continue; // letters directly before = part of another word
    }
    add('person', name);
  }

  // 4) orgs — capitalized sequences followed by org markers
  const orgSuffix = /\b([A-Z][A-Za-z0-9&'-]*(?:\s+[A-Z][A-Za-z0-9&'-]*){0,3})\s+(?:Inc|LLC|Ltd|GmbH|Corp|Corporation|Company|Labs|Technologies|Systems|University|Institute)\b/g;
  for (const m of text.matchAll(orgSuffix)) add('org', m[0].trim());

  // 5) topics — quoted phrases and #hashtags
  for (const m of text.matchAll(/"([^"]{3,60})"/g)) add('topic', m[1]);
  for (const m of text.matchAll(/(?:^|\s)#([a-z0-9-]{3,30})\b/gi)) add('topic', m[1]);

  // cap per memory to keep the graph tidy
  return [...out.values()].slice(0, 12);
}

/** Upsert an entity into the entities registry and link a memory to it.
 *  Reuses syncEntity's `<kind>:<slug>` convention + creates the graph link
 *  (memory)-[mentions]->(entity) so the Links Explorer picks it up. */
export async function linkMemoryEntities(db: DataPort, memoryId: string, entities: ExtractedEntity[]): Promise<string[]> {
  const now = iso();
  const linked: string[] = [];
  for (const e of entities) {
    const slug = entityIdFor(e.kind, e.name);
    const ref = `${e.kind}:${slug}`;
    // upsert entity registry row
    const existing = await db.query<any>('SELECT id FROM entities WHERE kind = ? AND entity_id = ?', [e.kind, slug]);
    if (existing.length === 0) {
      await db.run(
        'INSERT INTO entities (id, kind, entity_id, title, subtitle, meta, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [ref, e.kind, slug, e.name, `extracted from memory (kind: ${e.kind})`, JSON.stringify({ extracted: true }), now, now],
      );
    } else {
      await db.run("UPDATE entities SET updated_at = ? WHERE id = ?", [now, ref]);
    }
    // join row (idempotent)
    await db.run('INSERT INTO memory_entities (memory_id, entity_id, created_at) VALUES (?,?,?)', [memoryId, ref, now])
      .catch(() => { /* duplicate — fine */ });
    // graph link memory -[mentions]-> entity (idempotent-ish: one row per pair)
    const dupe = await db.query<any>(
      'SELECT id FROM links WHERE from_type = ? AND from_id = ? AND to_type = ? AND to_id = ? AND relation = ?',
      ['memory', memoryId, e.kind, slug, 'mentions'],
    );
    if (dupe.length === 0) {
      await db.run(
        'INSERT INTO links (id, from_type, from_id, to_type, to_id, relation, created_by, created_at) VALUES (?,?,?,?,?,?,?,?)',
        [crypto.randomUUID(), 'memory', memoryId, e.kind, slug, 'mentions', null, now],
      );
    }
    linked.push(ref);
  }
  return linked;
}

/** Backfill: run extraction over memories that predate Phase 5. Idempotent via
 *  the memory_entity_scan marker (memories with zero extracted entities have
 *  no join rows, so the marker — not the joins — is the source of truth).
 *  Returns how many memories were processed. */
export async function backfillEntities(db: DataPort, limit = 200): Promise<{ processed: number; entities: number; memories: number }> {
  const rows = await db.query<any>(
    `SELECT m.id, m.content FROM memories m
     LEFT JOIN memory_entity_scan s ON s.memory_id = m.id
     WHERE s.memory_id IS NULL
     ORDER BY m.updated_at DESC LIMIT ?`, [limit],
  );
  let entityCount = 0;
  const seen = new Set<string>();
  for (const r of rows) {
    const extracted = extractEntities(String(r.content));
    if (extracted.length) {
      await linkMemoryEntities(db, r.id, extracted).catch(() => {});
      entityCount += extracted.length;
      for (const e of extracted) seen.add(`${e.kind}:${entityIdFor(e.kind, e.name)}`);
    }
    // mark scanned either way (zero-entity memories are done, not pending)
    await db.run('INSERT INTO memory_entity_scan (memory_id, processed_at) VALUES (?,?)', [r.id, iso()])
      .catch(() => { /* already marked — fine */ });
  }
  return { processed: rows.length, entities: entityCount, memories: seen.size };
}
