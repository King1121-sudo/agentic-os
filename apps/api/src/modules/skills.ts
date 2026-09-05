/**
 * Skill Engine (Phase 4): inheritance, versioning, hot-loading, metrics.
 *
 * - A skill with `parent` inherits the parent's resolved steps (chain, cycle-guarded);
 *   its own steps run after the inherited ones.
 * - Every write to a skill snapshots the previous definition into `skill_versions`
 *   and bumps the version when the definition changes.
 * - Skill definitions live as JSON/YAML files in the skills dir (hot-loadable via
 *   POST /api/skills/reload); the loader diffs against the DB and only bumps
 *   versions for actual changes.
 * - Executions record per-skill history (`skill_executions`) with latency/status,
 *   aggregated by /api/skills/metrics.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { DataPort } from '../infra/types';
import { iso, uuid } from '../infra/types';
import { safeJson } from '../kernel/bus';
import { config } from '../config';
import type { SkillRecord } from '@agentic/contracts';
import { parseSkill } from './store';

const J = JSON.stringify;

export interface SkillDefInput {
  name: string;
  description?: string;
  category?: string;
  parent?: string | null;         // parent skill NAME (resolved at load)
  instructions?: string;
  steps: unknown[];
  required_tools?: string[];
}

// ─── chain resolution (inheritance) ─────────────────────────────────────────
/** Resolve a skill's full step chain: parent steps first (depth-first), then own.
 *  Cycle-safe: a visiting set breaks inheritance loops. */
export function resolveSkillChain(
  byName: Map<string, SkillRecord>,
  skill: SkillRecord,
  visiting: Set<string> = new Set(),
): { steps: SkillRecord['steps']; chain: string[]; missing_parent?: string } {
  const chain: string[] = [];
  const steps: SkillRecord['steps'] = [];

  const walk = (s: SkillRecord): void => {
    if (visiting.has(s.name)) return;            // cycle guard
    visiting.add(s.name);
    chain.push(s.name);
    if (s.parent_id) {
      const parent = [...byName.values()].find(x => x.id === s.parent_id);
      if (parent) walk(parent);
      else chain.push(`!missing:${s.parent_id}`);
    }
  };
  // collect chain names root-first
  walk(skill);
  const orderedNames = [...visiting]; // insertion order = child→parent; reverse for execution
  // build steps: ancestors first
  for (let i = orderedNames.length - 1; i >= 0; i--) {
    const s = byName.get(orderedNames[i]);
    if (s && s.name !== skill.name) steps.push(...s.steps);
  }
  steps.push(...skill.steps); // own steps last
  return { steps, chain: orderedNames };
}

/** All tools required across a resolved chain (for permission precheck). */
export function requiredToolsFor(byName: Map<string, SkillRecord>, skill: SkillRecord): string[] {
  const { steps } = resolveSkillChain(byName, skill);
  const tools = new Set<string>(skill.required_tools ?? []);
  for (const s of steps) if (s.kind === 'tool' && s.tool) tools.add(s.tool);
  return [...tools];
}

// ─── versioning ─────────────────────────────────────────────────────────────
function bumpVersion(v: string, defChanged: boolean): string {
  if (!defChanged) return v;
  const [maj, min, patch] = v.split('.').map(n => parseInt(n, 10) || 0);
  return `${maj}.${min}.${(patch ?? 0) + 1}`;
}

/** Insert or update a skill; snapshots the old definition and bumps the version
 *  when the payload changed. Returns {skill, version_bumped}. */
export async function upsertSkillVersioned(
  db: DataPort,
  def: SkillDefInput,
  bus?: { emit: (t: any, d: unknown, o?: any) => Promise<unknown> },
): Promise<{ skill: SkillRecord; version_bumped: boolean }> {
  const existing = (await db.query<any>('SELECT * FROM skills WHERE name = ?', [def.name]))[0];
  const now = iso();

  // resolve parent name → id
  let parent_id: string | null = null;
  if (def.parent) {
    const parentRow = (await db.query<any>('SELECT id FROM skills WHERE name = ?', [def.parent]))[0];
    parent_id = parentRow?.id ?? null;
  }

  if (existing) {
    const cur = parseSkill(existing);
    const changed =
      cur.description !== (def.description ?? '') ||
      cur.category !== (def.category ?? 'general') ||
      cur.instructions !== (def.instructions ?? '') ||
      J(cur.steps) !== J(def.steps ?? []) ||
      (cur.parent_id ?? null) !== parent_id;
    if (!changed) return { skill: cur, version_bumped: false };

    // snapshot current into skill_versions
    await db.run(
      `INSERT INTO skill_versions (skill_id, version, name, description, category, parent_id, instructions, steps, required_tools, required_permissions, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [cur.id, cur.version, cur.name, cur.description, cur.category, cur.parent_id,
       cur.instructions, J(cur.steps), J(cur.required_tools), J(cur.required_permissions), now],
    );
    const nextVersion = bumpVersion(cur.version, true);
    const reqTools = def.required_tools ?? toolsFromSteps(def.steps ?? []);
    await db.run(
      `UPDATE skills SET description=?, category=?, parent_id=?, instructions=?, steps=?, required_tools=?, required_permissions=?, version=?, updated_at=? WHERE id=?`,
      [def.description ?? '', def.category ?? 'general', parent_id, def.instructions ?? '',
       J(def.steps ?? []), J(reqTools), J([]), nextVersion, now, cur.id],
    );
    if (bus) await bus.emit('skill.version.bumped', { skill: cur.name, from: cur.version, to: nextVersion },
      { actor_type: 'system', target_type: 'skill', target_id: cur.id }).catch(() => {});
    const updated = (await db.query<any>('SELECT * FROM skills WHERE id = ?', [cur.id]))[0];
    return { skill: parseSkill(updated), version_bumped: true };
  }

  // create fresh at 0.1.0
  const id = uuid();
  const reqTools = def.required_tools ?? toolsFromSteps(def.steps ?? []);
  await db.run(
    `INSERT INTO skills (id, name, description, category, parent_id, version, instructions, steps, required_tools, required_permissions, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [id, def.name, def.description ?? '', def.category ?? 'general', parent_id, '0.1.0',
     def.instructions ?? '', J(def.steps ?? []), J(reqTools), J([]), now, now],
  );
  const created = (await db.query<any>('SELECT * FROM skills WHERE id = ?', [id]))[0];
  return { skill: parseSkill(created), version_bumped: false };
}

function toolsFromSteps(steps: unknown[]): string[] {
  const out = new Set<string>();
  for (const s of steps as any[]) if (s?.kind === 'tool' && s.tool) out.add(s.tool);
  return [...out];
}

// ─── execution history + metrics ────────────────────────────────────────────
export async function recordSkillExecution(
  db: DataPort,
  e: { skill_id: string; skill_version: string; execution_id?: string | null; agent_id?: string | null; status: 'completed' | 'failed' | 'denied'; error?: string | null; latency_ms: number },
): Promise<void> {
  await db.run(
    `INSERT INTO skill_executions (id, skill_id, skill_version, execution_id, agent_id, status, error, latency_ms, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [uuid(), e.skill_id, e.skill_version, e.execution_id ?? null, e.agent_id ?? null,
     e.status, e.error ?? null, e.latency_ms, iso()],
  );
}

export async function skillMetrics(db: DataPort): Promise<unknown[]> {
  const rows = await db.query<any>(`
    SELECT se.skill_id, s.name, s.version, s.category,
           COUNT(*) AS runs,
           SUM(CASE WHEN se.status = 'completed' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN se.status = 'failed' THEN 1 ELSE 0 END) AS failed,
           SUM(CASE WHEN se.status = 'denied' THEN 1 ELSE 0 END) AS denied,
           AVG(se.latency_ms) AS avg_latency_ms,
           MAX(se.created_at) AS last_run
    FROM skill_executions se
    LEFT JOIN skills s ON s.id = se.skill_id
    GROUP BY se.skill_id
    ORDER BY runs DESC`);
  return rows.map(r => ({
    ...r,
    runs: Number(r.runs), completed: Number(r.completed), failed: Number(r.failed), denied: Number(r.denied),
    avg_latency_ms: Math.round(Number(r.avg_latency_ms ?? 0)),
    success_rate: Number(r.runs) ? Number((Number(r.completed) / Number(r.runs)) * 100).toFixed(1) : null,
  }));
}

export async function skillVersions(db: DataPort, skillId?: string): Promise<unknown[]> {
  const rows = skillId
    ? await db.query<any>('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at DESC', [skillId])
    : await db.query<any>('SELECT * FROM skill_versions ORDER BY created_at DESC LIMIT 200');
  return rows.map(r => ({ ...r, steps: safeJson(r.steps), required_tools: safeJson(r.required_tools) }));
}

// ─── hot loader (JSON/YAML) ─────────────────────────────────────────────────
/** Minimal YAML subset parser for skill files (name/description/category/
 *  parent/instructions scalars + a `steps:` list of mappings with indented
 *  sub-keys). No external dependency — full YAML is overkill for this shape. */
export function parseSkillYaml(text: string): SkillDefInput {
  const out: any = { steps: [] };
  const lines = text.split(/\r?\n/);
  let inSteps = false;
  let currentStep: any = null;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const isList = /^[-]\s/.test(line.trim());
    const indent = line.length - line.trimStart().length;
    const content = line.trim();

    if (!inSteps) {
      const m = content.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (m && indent === 0 && !isList) {
        inSteps = m[1] === 'steps';
        if (!inSteps && m[2] !== '') out[m[1]] = m[2].replace(/^["']|["']$/g, '');
      }
      continue;
    }

    // inside steps:
    if (isList) {
      currentStep = {};
      out.steps.push(currentStep);
      const rest = content.slice(1).trim();
      const km = rest.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (km) currentStep[km[1]] = coerceYamlValue(km[2]);
    } else if (currentStep) {
      // continuation key of the current step
      const km = content.match(/^([A-Za-z_]+):\s*(.*)$/);
      if (km) currentStep[km[1]] = coerceYamlValue(km[2]);
      else if (indent === 0) inSteps = false; // left the steps block
    }
  }
  // normalize: tool steps carry `tool:`; model steps carry `capability:`
  out.steps = out.steps.map((s: any) => s.tool ? { kind: 'tool', ...s } : s.capability ? { kind: 'model', ...s } : s);
  if (!out.name) throw new Error('skill file missing name');
  return out as SkillDefInput;
}

function coerceYamlValue(v: string): unknown {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '' || v === '{}') return {};
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  return v.replace(/^["']|["']$/g, '');
}

export interface LoadResult { loaded: number; created: number; bumped: number; errors: string[] }

/** Scan the skills dir for .json/.yaml files and upsert each definition.
 *  Two-pass: pass 1 upserts definitions (parents may not resolve yet); pass 2
 *  re-runs so `parent` names resolve now that every skill exists — file order
 *  never affects the outcome. Diff-aware: unchanged defs are skipped. */
export async function loadSkillsFromDir(
  db: DataPort,
  dir: string = config.skillsDir,
  bus?: { emit: (t: any, d: unknown, o?: any) => Promise<unknown> },
): Promise<LoadResult> {
  const res: LoadResult = { loaded: 0, created: 0, bumped: 0, errors: [] };
  if (!fs.existsSync(dir)) { res.errors.push(`skills dir not found: ${dir}`); return res; }
  const files = fs.readdirSync(dir).filter(f => /\.(json|ya?ml)$/i.test(f));
  if (files.length === 0) return res;

  const defs: { file: string; def: SkillDefInput }[] = [];
  const parseErrorFiles = new Set<string>();
  for (const f of files) {
    try {
      const text = fs.readFileSync(path.join(dir, f), 'utf8');
      const def = /\.json$/i.test(f) ? JSON.parse(text) : parseSkillYaml(text);
      if (!Array.isArray(def.steps) || def.steps.length === 0) throw new Error('skill needs a non-empty steps array');
      defs.push({ file: f, def });
    } catch (e: any) {
      parseErrorFiles.add(f);
      res.errors.push(`${f}: ${String(e?.message ?? e)}`);
    }
  }
  // dedupe by name (later files win, mirroring DB upsert semantics)
  const byName = new Map<string, SkillDefInput>();
  for (const { def } of defs) byName.set(def.name, def);

  const known = new Set<string>();
  const runPass = async (pass: number): Promise<void> => {
    for (const [name, def] of byName) {
      try {
        const { skill, version_bumped } = await upsertSkillVersioned(db, def, bus);
        res.loaded++;
        if (version_bumped) {
          res.bumped++;
        } else if (pass === 1 && !known.has(name)) {
          known.add(name);
          // created on this load? (version 0.1.0 and no superseded snapshots)
          const snaps = await db.query<any>('SELECT COUNT(*) AS n FROM skill_versions WHERE skill_id = ?', [skill.id]);
          if (skill.version === '0.1.0' && Number(snaps[0]?.n ?? 0) === 0) res.created++;
        }
      } catch (e: any) {
        // count each failing skill once across passes
        const key = `${name}: ${String(e?.message ?? e)}`;
        if (!res.errors.includes(key)) res.errors.push(key);
      }
    }
  };
  await runPass(1);
  await runPass(2); // parent links now resolvable; diffs absorbed here
  return res;
}
