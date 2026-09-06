/**
 * Working Memory (Phase 5) — per-execution context windows.
 *
 * Every execution opens a working-memory window at planning time:
 *   - pinned memories: the top-k retrieved long-term memories (ids + summaries)
 *   - facts: bounded append-only notes appended as steps execute
 *   - the window feeds the synthesis prompt (and the planner), giving the
 *     agent a stable, inspectable "what do I know right now" surface.
 *
 * Bounds (anti-429, per the earlier prompt-growth audit): max 40 facts,
 * each ≤ 240 chars, oldest dropped; token estimate tracked for the UI.
 */
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import type { WorkingMemoryRecord } from '@agentic/contracts';
import { safeJson } from '../kernel/bus';
import { estimateTokens } from './text';

const MAX_FACTS = 40;
const MAX_FACT_CHARS = 240;

export async function openWorkingMemory(
  db: DataPort,
  w: { execution_id: string; user_id: string; agent_id: string; pinned_memory_ids: string[] },
): Promise<WorkingMemoryRecord> {
  const now = iso();
  const rec: WorkingMemoryRecord = {
    id: uuid(), execution_id: w.execution_id, user_id: w.user_id, agent_id: w.agent_id,
    pinned_memory_ids: w.pinned_memory_ids.slice(0, 20), facts: [],
    token_estimate: 0, created_at: now, updated_at: now, closed_at: null,
  };
  await db.run(
    `INSERT INTO working_memory (id, execution_id, user_id, agent_id, pinned_memory_ids, facts, token_estimate, created_at, updated_at, closed_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [rec.id, rec.execution_id, rec.user_id, rec.agent_id, JSON.stringify(rec.pinned_memory_ids),
     JSON.stringify(rec.facts), 0, rec.created_at, rec.updated_at, null],
  );
  return rec;
}

export async function appendFact(
  db: DataPort, executionId: string,
  f: { text: string; source: string; step?: number },
): Promise<WorkingMemoryRecord | null> {
  const rows = await db.query<any>('SELECT * FROM working_memory WHERE execution_id = ?', [executionId]);
  const row = rows[0];
  if (!row) return null;
  const facts = safeJson(row.facts) as WorkingMemoryRecord['facts'];
  facts.push({ ts: iso(), step: f.step ?? 0, source: f.source.slice(0, 60), text: f.text.slice(0, MAX_FACT_CHARS) });
  // bound the window: oldest facts drop off
  while (facts.length > MAX_FACTS) facts.shift();
  const token_estimate = facts.reduce((s: number, x: WorkingMemoryRecord['facts'][number]) => s + estimateTokens(x.text), 0);
  const updated = iso();
  await db.run('UPDATE working_memory SET facts = ?, token_estimate = ?, updated_at = ? WHERE execution_id = ?',
    [JSON.stringify(facts), token_estimate, updated, executionId]);
  return { ...parseWorkingMemory(row), facts, token_estimate, updated_at: updated };
}

export async function getWorkingMemory(db: DataPort, executionId: string): Promise<WorkingMemoryRecord | null> {
  const rows = await db.query<any>('SELECT * FROM working_memory WHERE execution_id = ?', [executionId]);
  return rows[0] ? parseWorkingMemory(rows[0]) : null;
}

export async function closeWorkingMemory(db: DataPort, executionId: string): Promise<void> {
  await db.run('UPDATE working_memory SET closed_at = ?, updated_at = ? WHERE execution_id = ? AND closed_at IS NULL',
    [iso(), iso(), executionId]).catch(() => {});
}

/** Render the window as a compact prompt block (used by planner + synthesis). */
export function renderWorkingMemory(w: WorkingMemoryRecord | null): string {
  if (!w) return '';
  const lines: string[] = [];
  if (w.pinned_memory_ids.length) lines.push(`Pinned memory ids: ${w.pinned_memory_ids.join(', ')}`);
  if (w.facts.length) {
    lines.push('Working memory facts:');
    for (const f of w.facts.slice(-12)) lines.push(`- (step ${f.step}, ${f.source}) ${f.text}`);
  }
  return lines.join('\n');
}

function parseWorkingMemory(r: any): WorkingMemoryRecord {
  return {
    id: r.id, execution_id: r.execution_id, user_id: r.user_id, agent_id: r.agent_id,
    pinned_memory_ids: safeJson(r.pinned_memory_ids), facts: safeJson(r.facts),
    token_estimate: r.token_estimate, created_at: r.created_at, updated_at: r.updated_at,
    closed_at: r.closed_at,
  };
}
