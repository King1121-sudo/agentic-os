/**
 * Model Router — the heart of the Model Gateway (§8).
 * Agents ask for a CAPABILITY; the router picks provider+model using:
 *   1. agent preference (provider_id/model_id)
 *   2. capability match
 *   3. provider health (probed at boot + on failure)
 *   4. priority, then cost
 * Automatic fallback: if a provider errors mid-request, the next candidate is tried.
 * Every generation is recorded with model, tokens, latency, cost (§21).
 */
import { ModelProviderPort, ModelRequest, ModelResponse } from '../kernel/types';
import { Capability } from '@agentic/contracts';
import { DataPort } from '../infra/types';
import { iso } from '../infra/types';
import { estimateTokens } from './providers';
import { lookupCosts } from './costs';


interface RouterModel {
  id: string; model_id: string; provider_id: string; capabilities: Capability[];
  priority: number; cost_in: number; cost_out: number;
}

export class ModelRouter {
  private providers = new Map<string, ModelProviderPort>();
  private models: RouterModel[] = [];
  private healthy = new Set<string>();

  constructor(private db: DataPort, private recordGeneration: (g: any) => Promise<void>) {}

  register(p: ModelProviderPort) { this.providers.set(p.id, p); }

  async bootstrap(): Promise<{ providers: any[]; models: number }> {
    const out: any[] = [];
    for (const p of this.providers.values()) {
      let status = 'down';
      let modelIds: string[] = [];
      try {
        if (await p.healthy()) {
          status = 'up';
          modelIds = (await p.listModels().catch(() => []));
          this.healthy.add(p.id);
        }
      } catch { status = 'down'; }
      if (!this.healthy.has(p.id)) this.healthy.delete(p.id);

      // persist provider
      const now = iso();
      const exists = await this.db.query('SELECT id FROM model_providers WHERE id = ?', [p.id]);
      if (exists.length === 0) {
        await this.db.run(
          'INSERT INTO model_providers (id, name, kind, base_url, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          [p.id, p.name, p.kind, p.kind === 'builtin' ? null : describeUrl(p), status, now, now],
        );
      } else {
        await this.db.run('UPDATE model_providers SET status = ?, updated_at = ? WHERE id = ?', [status, now, p.id]);
      }

      // persist models + capabilities
      for (const mid of modelIds) {
        await this.upsertModel(p, mid);
      }
      out.push({ id: p.id, status, models: modelIds.length });
    }
    await this.loadModels();
    return { providers: out, models: this.models.length };
  }

  private async upsertModel(p: ModelProviderPort, mid: string) {
    const fullId = `${p.id}:${mid}`;
    const caps = inferCapabilities(p, mid);
    const costs = lookupCosts(p.kind, mid) ?? { in: 0, out: 0 };
    const now = iso();
    const exists = await this.db.query('SELECT id, cost_in_per_mtok FROM models WHERE id = ?', [fullId]);
    if (exists.length === 0) {
      await this.db.run(
        `INSERT INTO models (id, provider_id, family, display_name, capabilities, context_limit,
          cost_in_per_mtok, cost_out_per_mtok, priority, health, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [fullId, p.id, p.id, mid, JSON.stringify(caps), 8192, costs.in, costs.out, defaultPriority(caps), 'unknown', now, now],
      );
    } else {
      // only overwrite cost when a real price is known (never zero-out a known price with null)
      const known = costs.in > 0 || costs.out > 0;
      await this.db.run(
        known
          ? 'UPDATE models SET capabilities = ?, cost_in_per_mtok = ?, cost_out_per_mtok = ?, updated_at = ? WHERE id = ?'
          : 'UPDATE models SET capabilities = ?, updated_at = ? WHERE id = ?',
        known
          ? [JSON.stringify(caps), costs.in, costs.out, now, fullId]
          : [JSON.stringify(caps), now, fullId],
      );
    }
  }

  private async loadModels() {
    const rows = await this.db.query<any>(
      `SELECT id, provider_id, capabilities, priority, cost_in_per_mtok, cost_out_per_mtok
       FROM models WHERE provider_id IN (${[...this.providers.keys()].map(() => '?').join(',')})
       ORDER BY priority DESC`,
      [...this.providers.keys()],
    );
    this.models = rows.map(r => ({
      id: r.id, model_id: r.id.split(':').slice(1).join(':'), provider_id: r.provider_id,
      capabilities: safeArr(r.capabilities) as Capability[], priority: r.priority,
      cost_in: r.cost_in_per_mtok, cost_out: r.cost_out_per_mtok,
    }));
  }

  private candidates(capability: string, preference?: { provider_id?: string; model_id?: string }[]): RouterModel[] {
    const healthyProviders = new Set([...this.providers.keys()].filter(id => this.healthy.has(id)));
    let list = this.models.filter(m => healthyProviders.has(m.provider_id));
    // preference order first
    if (preference?.length) {
      const pref = list.filter(m => preference.some(p =>
        (p.model_id && m.model_id.includes(p.model_id)) ||
        (p.provider_id && m.provider_id === p.provider_id && !p.model_id)));
      list = [...pref, ...list.filter(m => !pref.includes(m))];
    }
    const capMatch = list.filter(m => m.capabilities.includes(capability as Capability));
    const fallback = capMatch.length ? capMatch : list;
    return fallback.sort((a, b) => b.priority - a.priority || (a.cost_in + a.cost_out) - (b.cost_in + b.cost_out));
  }

  /** Generate with automatic fallback across candidate providers. Records every attempt as a Generation. */
  async generate(
    req: ModelRequest,
    opts: { agent_id?: string | null; execution_id?: string | null; preference?: { provider_id?: string; model_id?: string }[] } = {},
  ): Promise<ModelResponse> {
    const cands = this.candidates(req.capability, opts.preference);
    if (cands.length === 0) {
      // last-ditch: builtin provider directly (never registered as down)
      const builtin = this.providers.get('builtin')!;
      const started = await this.recordStart(newGenId(), {
        id: 'builtin:planner', model_id: 'planner', provider_id: 'builtin',
        capabilities: [], priority: 0, cost_in: 0, cost_out: 0,
      } as RouterModel, req, opts);
      try {
        const resp = await builtin.generate(req, 'planner');
        await this.recordFinish(started, resp, 'completed');
        return resp;
      } catch (e: any) {
        await this.recordFinish(started, null, 'failed', String(e?.message ?? e));
        throw e;
      }
    }
    let lastErr: Error | null = null;
    for (const cand of cands.slice(0, 4)) {
      const provider = this.providers.get(cand.provider_id);
      if (!provider) continue;
      const genId = newGenId();
      const started = await this.recordStart(genId, cand, req, opts);
      try {
        const resp = await provider.generate(req, cand.model_id);
        await this.recordFinish(started, resp, 'completed');
        return resp;
      } catch (e: any) {
        lastErr = e;
        await this.recordFinish(started, null, 'failed', String(e?.message ?? e));
        if ((e as any)?.aborted) throw e; // cancellation is not a failover condition
        this.healthy.delete(cand.provider_id);
        await this.db.run('UPDATE model_providers SET status = ?, updated_at = ? WHERE id = ?', ['down', iso(), cand.provider_id]);
        continue; // fallback to next candidate
      }
    }
    throw new Error(`All model candidates failed: ${lastErr?.message ?? 'unknown'}`);
  }

  /** Phase 2: streaming generate. Same fallback semantics as generate(); token
   *  deltas surface via onToken (volatile — NOT persisted as events); abort
   *  via signal marks the generation cancelled. */
  async generateStream(
    req: ModelRequest,
    onToken: (delta: string, meta: { model_id: string }) => void,
    opts: { agent_id?: string | null; execution_id?: string | null; preference?: { provider_id?: string; model_id?: string }[] } = {},
    signal?: AbortSignal,
  ): Promise<ModelResponse> {
    const cands = this.candidates(req.capability, opts.preference);
    const tryOne = async (cand: RouterModel, _started: any): Promise<ModelResponse> => {
      const provider = this.providers.get(cand.provider_id)!;
      if (provider.generateStream) {
        return provider.generateStream(req, cand.model_id, (d) => onToken(d, { model_id: cand.id }), signal);
      }
      // provider lacks streaming → single-chunk fallback, still fires onToken once
      const resp = await provider.generate(req, cand.model_id);
      if (!signal?.aborted) onToken(resp.text, { model_id: cand.id });
      return resp;
    };
    const run = async (cand: RouterModel): Promise<ModelResponse> => {
      const started = await this.recordStart(newGenId(), cand, req, opts);
      try {
        const resp = await tryOne(cand, started);
        await this.recordFinish(started, resp, 'completed');
        return resp;
      } catch (e: any) {
        if ((e as any)?.aborted || signal?.aborted) {
          await this.recordFinish(started, null, 'cancelled', 'aborted by user');
          throw e;
        }
        await this.recordFinish(started, null, 'failed', String(e?.message ?? e));
        this.healthy.delete(cand.provider_id);
        await this.db.run('UPDATE model_providers SET status = ?, updated_at = ? WHERE id = ?', ['down', iso(), cand.provider_id]);
        throw e;
      }
    };

    if (cands.length === 0) {
      const started = await this.recordStart(newGenId(), {
        id: 'builtin:planner', model_id: 'planner', provider_id: 'builtin',
        capabilities: [], priority: 0, cost_in: 0, cost_out: 0,
      } as RouterModel, req, opts);
      try {
        const resp = await tryOne({ id: 'builtin:planner', model_id: 'planner', provider_id: 'builtin', capabilities: [], priority: 0, cost_in: 0, cost_out: 0 }, started);
        await this.recordFinish(started, resp, 'completed');
        return resp;
      } catch (e: any) {
        await this.recordFinish(started, null, (e as any)?.aborted ? 'cancelled' : 'failed', String(e?.message ?? e));
        throw e;
      }
    }

    let lastErr: Error | null = null;
    for (const cand of cands.slice(0, 4)) {
      try { return await run(cand); } catch (e: any) {
        if ((e as any)?.aborted) throw e;
        lastErr = e;
      }
    }
    throw new Error(`All model candidates failed: ${lastErr?.message ?? 'unknown'}`);
  }

  /** Phase 2: per-model usage accounting from the generations ledger. */
  async usage(): Promise<unknown[]> {
    const rows = await this.db.query<any>(`
      SELECT model_id, provider_id,
             COUNT(*) AS generations,
             SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
             SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
             SUM(input_tokens) AS tokens_in,
             SUM(output_tokens) AS tokens_out,
             SUM(cost) AS cost,
             AVG(latency_ms) AS avg_latency_ms
      FROM generations
      GROUP BY model_id, provider_id
      ORDER BY cost DESC`);
    return rows.map(r => ({
      ...r,
      generations: Number(r.generations), completed: Number(r.completed), failed: Number(r.failed), cancelled: Number(r.cancelled),
      tokens_in: Number(r.tokens_in), tokens_out: Number(r.tokens_out),
      cost: Number(r.cost), avg_latency_ms: Number(r.avg_latency_ms ?? 0),
    }));
  }

  async refreshHealth(): Promise<void> {
    for (const p of this.providers.values()) {
      const ok = await p.healthy().catch(() => false);
      if (ok) this.healthy.add(p.id); else this.healthy.delete(p.id);
      await this.db.run('UPDATE model_providers SET status = ?, updated_at = ? WHERE id = ?', [ok ? 'up' : 'down', iso(), p.id]).catch(() => {});
    }
  }

  listProviders() {
    return [...this.providers.values()].map(p => ({ id: p.id, name: p.name, kind: p.kind, healthy: this.healthy.has(p.id) }));
  }

  listModels() {
    return this.db.query(`SELECT m.*, p.status AS provider_status FROM models m
      JOIN model_providers p ON p.id = m.provider_id ORDER BY m.priority DESC, m.id`);
  }

  // ─── generation recording (§21) ──────────────────────────────────────────
  private async recordStart(genId: string, cand: RouterModel, req: ModelRequest, opts: any) {
    const now = iso();
    const g = {
      id: genId, agent_id: opts.agent_id ?? null, execution_id: opts.execution_id ?? null,
      parent_generation_id: null, model_id: cand.id, provider_id: cand.provider_id,
      kind: req.capability, input: { system: req.system, user: req.prompt, hint: req.hint ?? null },
      output: null, context: { memories_used: [], tools_used: [] },
      input_tokens: 0, output_tokens: 0, latency_ms: 0,
      cost: 0, status: 'started', error: null, created_at: now, completed_at: null,
    };
    await this.db.run(
      `INSERT INTO generations (id, agent_id, execution_id, parent_generation_id, model_id, provider_id, kind,
        input, output, context, input_tokens, output_tokens, latency_ms, cost, status, error, created_at, completed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [g.id, g.agent_id, g.execution_id, g.parent_generation_id, g.model_id, g.provider_id, g.kind,
       JSON.stringify(g.input), null, JSON.stringify(g.context), 0, 0, 0, 0, 'started', null, now, null],
    );
    return g;
  }

  private async recordFinish(g: any, resp: ModelResponse | null, status: 'completed' | 'failed' | 'cancelled', error?: string) {
    const cost = resp
      ? (resp.input_tokens / 1e6) * (await this.costFor(g.model_id, 'in')) +
        (resp.output_tokens / 1e6) * (await this.costFor(g.model_id, 'out'))
      : 0;
    await this.db.run(
      `UPDATE generations SET output = ?, input_tokens = ?, output_tokens = ?, latency_ms = ?, cost = ?,
       status = ?, error = ?, completed_at = ? WHERE id = ?`,
      [resp?.text ?? null, resp?.input_tokens ?? estimateTokens(g.input?.user ?? ''), resp?.output_tokens ?? 0,
       resp?.latency_ms ?? 0, cost, status, error ?? null, iso(), g.id],
    );
    if (this.recordGeneration) await this.recordGeneration(g);
  }

  private async costFor(model_id: string, dir: 'in' | 'out'): Promise<number> {
    const r = await this.db.query<any>('SELECT cost_in_per_mtok, cost_out_per_mtok FROM models WHERE id = ?', [model_id]);
    return dir === 'in' ? (r[0]?.cost_in_per_mtok ?? 0) : (r[0]?.cost_out_per_mtok ?? 0);
  }
}

function newGenId(): string { return crypto.randomUUID(); }
function safeArr(v: unknown): string[] { try { const p = JSON.parse(String(v)); return Array.isArray(p) ? p : []; } catch { return []; } }
function describeUrl(p: ModelProviderPort): string { return (p as any).baseUrl ?? ''; }

function inferCapabilities(p: ModelProviderPort, mid: string): Capability[] {
  const m = mid.toLowerCase();
  const caps: Capability[] = ['chat'];
  if (p.kind === 'builtin') {
    if (/planner/.test(m)) caps.push('planning');
    if (/summarizer/.test(m)) caps.push('writing');
    if (/reasoner/.test(m)) caps.push('reasoning', 'writing');
  } else {
    if (/gpt-4|gpt-5|o[134]|claude|gemini.*pro|qwen.*instruct|llama.*instruct|deepseek-r1|qwen3|glm|kimi|mistral|mixtral/.test(m)) caps.push('planning', 'reasoning');
    if (/mini|nano|flash|fast|8b|7b|small/.test(m)) caps.push('reasoning');
    caps.push('writing');
  }
  return caps;
}

function defaultPriority(caps: Capability[]): number {
  let p = 10;
  if (caps.includes('planning')) p += 30;
  if (caps.includes('reasoning')) p += 20;
  if (caps.includes('writing')) p += 5;
  return p;
}
