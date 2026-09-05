/** Phase 4 tests: skill inheritance, versioning, hot-loading, metrics, permission precheck. */
import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { SqliteDataPort } from '../infra/sqlite.adapter';
import { runMigrations } from '../infra/migrations';
import {
  upsertSkillVersioned, resolveSkillChain, requiredToolsFor, parseSkillYaml,
  loadSkillsFromDir, recordSkillExecution, skillMetrics,
} from '../modules/skills';
import * as store from '../modules/store';

let db: SqliteDataPort;

beforeAll(async () => {
  const file = path.resolve(__dirname, '..', '..', '..', 'data', `test-phase4-${Date.now()}.db`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new SqliteDataPort(file);
  await runMigrations(db);
});

describe('phase 4 — inheritance chain', () => {
  it('child inherits parent steps (parent-first order), own steps last', async () => {
    await upsertSkillVersioned(db, {
      name: 'Base Research', category: 'research', description: 'parent',
      steps: [
        { kind: 'tool', tool: 'http.fetch', args: {} },
        { kind: 'model', capability: 'reasoning', prompt: 'summarize' },
      ],
    });
    await upsertSkillVersioned(db, {
      name: 'Base Extended', category: 'research', description: 'child', parent: 'Base Research',
      steps: [{ kind: 'tool', tool: 'memory.write', args: {} }],
    });
    const all = await store.listSkills(db);
    const byName = new Map(all.map(s => [s.name, s]));
    const child = byName.get('Base Extended')!;
    const chain = resolveSkillChain(byName, child);
    expect(chain.steps.map(s => (s as any).tool ?? (s as any).capability)).toEqual(
      ['http.fetch', 'reasoning', 'memory.write'],
    );
    expect(chain.chain).toEqual(['Base Extended', 'Base Research']);
  });

  it('cycle guard: self-referencing/looping parents do not hang', async () => {
    const all = await store.listSkills(db);
    const byName = new Map(all.map(s => [s.name, s]));
    const a = byName.get('Base Research')!;
    const fake = { ...a, name: 'LoopSelf', parent_id: a.id, steps: [], id: a.id } as any;
    const chain = resolveSkillChain(byName, fake); // same id in chain twice → visiting set breaks
    expect(chain.steps).toBeDefined();
  });

  it('requiredToolsFor unions tools across the chain', async () => {
    const all = await store.listSkills(db);
    const byName = new Map(all.map(s => [s.name, s]));
    const tools = requiredToolsFor(byName, byName.get('Base Extended')!);
    expect(tools).toContain('http.fetch');
    expect(tools).toContain('memory.write');
  });
});

describe('phase 4 — versioning', () => {
  it('unchanged definition is a no-op; changes snapshot + bump', async () => {
    const first = await upsertSkillVersioned(db, {
      name: 'Versioned Skill', category: 'general', description: 'v1 content',
      steps: [{ kind: 'tool', tool: 'notify', args: {} }],
    });
    expect(first.skill.version).toBe('0.1.0');
    expect(first.version_bumped).toBe(false);

    const same = await upsertSkillVersioned(db, {
      name: 'Versioned Skill', category: 'general', description: 'v1 content',
      steps: [{ kind: 'tool', tool: 'notify', args: {} }],
    });
    expect(same.version_bumped).toBe(false);   // diff-aware: no version churn

    const changed = await upsertSkillVersioned(db, {
      name: 'Versioned Skill', category: 'general', description: 'v2 content',
      steps: [{ kind: 'tool', tool: 'notify', args: {} }],
    });
    expect(changed.version_bumped).toBe(true);
    expect(changed.skill.version).toBe('0.1.1');

    const versions = await db.query<any>('SELECT * FROM skill_versions WHERE skill_id = ?', [changed.skill.id]);
    expect(versions.length).toBe(1);
    expect(versions[0].version).toBe('0.1.0');  // the superseded snapshot
    expect(versions[0].description).toBe('v1 content');
  });
});

describe('phase 4 — YAML parsing', () => {
  it('parses scalars and flat step lists', () => {
    const def = parseSkillYaml(`
# comment
name: Test Skill
description: A yaml skill
category: testing
parent: Base Research
instructions: Be careful.
steps:
  - kind: tool
    tool: memory.write
    args: {}
  - kind: model
    capability: reasoning
    prompt: sum it up
`);
    expect(def.name).toBe('Test Skill');
    expect(def.parent).toBe('Base Research');
    expect(def.steps).toEqual([
      { kind: 'tool', tool: 'memory.write', args: {} },
      { kind: 'model', capability: 'reasoning', prompt: 'sum it up' },
    ]);
  });

  it('rejects files without a name', () => {
    expect(() => parseSkillYaml('description: no name here\nsteps:\n  - kind: model\n')).toThrow(/name/);
  });
});

describe('phase 4 — hot loader', () => {
  it('loads JSON and YAML from a dir, diff-aware', async () => {
    const dir = path.resolve(__dirname, '..', '..', '..', '..', 'skills');
    const res = await loadSkillsFromDir(db, dir);
    expect(res.errors).toEqual([]);
    expect(res.loaded).toBeGreaterThanOrEqual(4); // 4 files in repo skills/
    // second load: no changes → nothing bumped
    const res2 = await loadSkillsFromDir(db, dir);
    expect(res2.bumped).toBe(0);

    // inheritance resolved from files: the extended skill has a parent
    const all = await store.listSkills(db);
    const ext = all.find(s => s.name === 'Research & Save Extended');
    expect(ext).toBeDefined();
    expect(ext!.parent_id).toBeTruthy();

    // chain includes the parent's steps
    const byName = new Map(all.map(s => [s.name, s]));
    const chain = resolveSkillChain(byName, ext!);
    const toolSeq = chain.steps.map(s => (s as any).tool ?? (s as any).capability);
    expect(toolSeq).toContain('http.fetch');      // inherited from Research & Save
    expect(toolSeq).toContain('memory.write');    // own step
    expect(toolSeq.indexOf('http.fetch')).toBeLessThan(toolSeq.indexOf('memory.write')); // parent first
  });

  it('reports per-file errors without failing the batch', async () => {
    const tmp = path.resolve(__dirname, '..', '..', '..', 'data', `skills-bad-${Date.now()}`);
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'good.json'), JSON.stringify({ name: 'Good One', steps: [{ kind: 'tool', tool: 'notify' }] }));
    fs.writeFileSync(path.join(tmp, 'bad.json'), '{ not valid json');
    const res = await loadSkillsFromDir(db, tmp);
    // two-pass loader: the good skill upserts once per pass (parent resolution)
    expect(res.loaded).toBe(2);
    expect(res.created).toBe(1);
    expect(res.errors.length).toBe(1);
    expect(res.errors[0]).toContain('bad.json');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('phase 4 — metrics', () => {
  it('aggregates runs, success rate, latency per skill', async () => {
    // self-sufficient: ensure the skill exists regardless of test filtering order
    const upserted = await upsertSkillVersioned(db, {
      name: 'Daily Briefing', category: 'productivity', description: 'Compile open tasks and system info into a terse briefing.',
      steps: [
        { kind: 'tool', tool: 'task.list', args: { status: 'todo' } },
        { kind: 'tool', tool: 'sys.info', args: {} },
        { kind: 'model', capability: 'writing', prompt: 'Compose a terse daily briefing from the task list and system info.' },
      ],
    });
    const skill = upserted.skill;
    await recordSkillExecution(db, { skill_id: skill.id, skill_version: skill.version, status: 'completed', latency_ms: 100 });
    await recordSkillExecution(db, { skill_id: skill.id, skill_version: skill.version, status: 'completed', latency_ms: 300 });
    await recordSkillExecution(db, { skill_id: skill.id, skill_version: skill.version, status: 'failed', error: 'x', latency_ms: 200 });
    const m = await skillMetrics(db) as any[];
    const row = m.find(x => x.name === 'Daily Briefing');
    expect(row).toBeDefined();
    expect(row.runs).toBeGreaterThanOrEqual(3);
    expect(row.completed).toBeGreaterThanOrEqual(2);
    expect(row.success_rate).toBe('66.7');
    expect(row.avg_latency_ms).toBe(200);
  });
});
