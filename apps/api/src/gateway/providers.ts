/**
 * Model Gateway adapters.
 *
 * builtin  — deterministic planner/summarizer/reasoner. No network, no keys.
 *            Runs the entire kernel with zero external dependencies; every
 *            generation is still recorded (tokens estimated by length).
 * openai-compat — any /v1/chat/completions API (OpenAI, Groq, OpenRouter, ...).
 * ollama   — local models via /api/chat.
 *
 * The router (gateway/router.ts) probes health and picks models by capability,
 * preference, priority and cost — agents never hard-code providers (§8).
 */
import type { ModelProviderPort, ModelRequest, ModelResponse } from '../kernel/types';
import type { Plan } from '@agentic/contracts';
import { PlanSchema } from '@agentic/contracts';

// ─── shared fetch/stream helpers ────────────────────────────────────────────
async function fetchJson(url: string, init: RequestInit, timeoutMs = 60000): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { /* non-json */ }
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    return json;
  } finally { clearTimeout(t); }
}

/** Read an SSE/http-stream body, invoking onJson for each parsed JSON chunk. Honors an external abort signal. */
async function readChunks(
  res: { body: any },
  extract: (chunkJson: any) => string | null,
  onChunk: (rawLine: string) => void,
  signal?: AbortSignal,
  lineSplit: 'sse' | 'nl' = 'sse',
): Promise<void> {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const onAbort = () => { try { reader.cancel(); } catch { /* already closed */ } };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split(lineSplit === 'nl' ? '\n' : '\n\n');
      buf = parts.pop() ?? '';
      for (const part of parts) {
        const line = part.trim();
        if (!line) continue;
        if (lineSplit === 'sse') {
          if (!line.startsWith('data:')) continue; // skip event:/comment lines
          const payload = line.slice(5).trim();
          if (payload === '[DONE]') return;
          try { const delta = extract(JSON.parse(payload)); if (delta) onChunk(delta); } catch { /* partial */ }
        } else {
          try { const delta = extract(JSON.parse(line)); if (delta) onChunk(delta); } catch { /* partial */ }
        }
      }
      if (signal?.aborted) return;
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}

export function estimateTokens(s: string): number {
  // ~4 chars/token heuristic — deterministic, no tokenizer dependency
  return Math.max(1, Math.ceil(s.length / 4));
}

/** Parse a plan out of a model response; tolerates ```json fences. */
export function parsePlanFromText(text: string): Plan | null {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fence ? fence[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1));
    const plan = PlanSchema.safeParse(parsed);
    return plan.success ? plan.data : null;
  } catch { return null; }
}

// ─── builtin deterministic provider ─────────────────────────────────────────
export class BuiltinProvider implements ModelProviderPort {
  id = 'builtin';
  name = 'Builtin Deterministic';
  kind = 'builtin' as const;

  async healthy(): Promise<boolean> { return true; }
  async listModels(): Promise<string[]> { return ['planner', 'summarizer', 'reasoner']; }

  async generate(req: ModelRequest, model_id: string): Promise<ModelResponse> {
    const t0 = Date.now();
    const inTok = estimateTokens(`${req.system ?? ''}\n${req.prompt}`);
    let text = '';
    let plan: Plan | null = null;

    if (req.capability === 'planning') {
      plan = heuristicPlan(req.prompt, req.hint);
      text = JSON.stringify(plan, null, 2);
    } else if (model_id === 'summarizer') {
      text = summarize(req.prompt);
    } else {
      text = reason(req.prompt);
    }
    return {
      text, plan: plan ?? undefined,
      model_id: 'builtin:' + model_id, provider_id: this.id,
      input_tokens: inTok, output_tokens: estimateTokens(text),
      latency_ms: Date.now() - t0,
    };
  }

  /** Phase 2: word-by-word deterministic streaming so the entire stream path
   *  (SSE → UI) is exercisable with zero external dependencies. */
  async generateStream(req: ModelRequest, model_id: string, onToken: (delta: string) => void, signal?: AbortSignal): Promise<ModelResponse> {
    const base = await this.generate(req, model_id);
    if (signal?.aborted) throw abortErr();
    for (const word of base.text.split(/(?<=\s)/)) {
      if (signal?.aborted) throw abortErr();
      onToken(word);
      await sleep(12); // visible cadence for live UI
    }
    return base;
  }
}

/**
 * Heuristic planner: keyword-driven step selection. Deterministic, explainable,
 * and honest about what it is — the model adapters produce LLM-quality plans.
 * Tool vocabulary it understands (matches the registered builtin tools):
 *   memory.write, memory.search, task.create, task.update, task.list,
 *   project.create, http.fetch, file.write, shell.run, notify, calc.eval
 */
/** Heuristic planner: keyword-driven step selection WITH argument extraction,
 * so "create a task to fix the login bug" produces a real task.create step
 * with a real title. Deterministic, explainable, honest about what it is —
 * LLM provider adapters produce higher-quality plans through the same port. */
const PLAN_TOOL_HINTS: { re: RegExp; step: any }[] = [
  { re: /\b(remember|note|don'?t forget|keep in mind)\b/i, step: { kind: 'tool', tool: 'memory.write', args: {} } },
  { re: /\b(what do you (know|remember)|recall|memory|remind me)\b/i, step: { kind: 'tool', tool: 'memory.search', args: { k: 5 } } },
  { re: /\b(create|add|new|make|open)\s+(a\s+)?(task|todo|item)\b/i, step: { kind: 'tool', tool: 'task.create', args: {} } },
  { re: /\b(create|add|new|start|make)\s+(a\s+)?(project|workspace)\b/i, step: { kind: 'tool', tool: 'project.create', args: {} } },
  { re: /\b(list|show|all)\s+(tasks?|todos?|backlog)\b/i, step: { kind: 'tool', tool: 'task.list', args: {} } },
  { re: /\b(complete|finish|done with|mark)\b.*\btask\b/i, step: { kind: 'tool', tool: 'task.update', args: { status: 'done' } } },
  { re: /https?:\/\/\S+/i, step: { kind: 'tool', tool: 'http.fetch', args: {} } },
  { re: /\b(fetch|get|download|call)\b.*\b(url|http|api|endpoint|site|website|page)\b/i, step: { kind: 'tool', tool: 'http.fetch', args: {} } },
  { re: /\b(save|write|store)\b.*\bfile\b/i, step: { kind: 'tool', tool: 'file.write', args: {} } },
  { re: /\b(run|execute)\b.*\b(command|shell|script)\b/i, step: { kind: 'tool', tool: 'shell.run', args: {} } },
  { re: /\b(notify|alert|ping me|send (?:a )?notification|remind me)\b/i, step: { kind: 'tool', tool: 'notify', args: {} } },
  { re: /\b(calc|compute|evaluate)\b/i, step: { kind: 'tool', tool: 'calc.eval', args: {} } },
];

/** Extract plausible args for a tool from free text. */
function extractArgs(tool: string, prompt: string): Record<string, unknown> {
  const t = prompt.trim();

  if (tool === 'task.create') {
    let title = '';
    const m1 = t.match(/(?:task|todo|item)\s+(?:to|for|called|named|titled|[:\-])\s+(.+)$/i);
    const m2 = t.match(/^(?:create|add|new|make|open)\s+(?:a\s+)?(?:task|todo|item)\s+(?:to\s+)?(.+)$/i);
    const m3 = t.match(/["“']([^"”']{3,120})["”']/);
    title = (m1?.[1] ?? m2?.[1] ?? m3?.[1] ?? t).trim();
    // strip trailing urgency/priority words (they belong in `priority`, not the title)
    title = title.replace(/,?\s*\b(?:urgent|asap|critical|high priority|important)\b\.?\s*$/i, '').replace(/[.!?]+$/, '').trim();
    // strip trailing "in project X" fragments into the project arg
    let project_name: string | undefined;
    const pm = title.match(/\s+(?:in|under|for)\s+(?:the\s+)?(?:project\s+)?["“']?([A-Za-z0-9][A-Za-z0-9 _-]{1,40})["”']?\s*$/i);
    if (pm) { project_name = pm[1].trim(); title = title.slice(0, pm.index).trim(); }
    const urgency = /\b(urgent|asap|critical|now)\b/i.test(t) ? 'urgent' : /\b(important|high priority)\b/i.test(t) ? 'high' : 'medium';
    const args: Record<string, unknown> = { title, priority: urgency };
    if (project_name) args.project_name = project_name;
    return args;
  }

  if (tool === 'project.create') {
    const m = t.match(/(?:project|workspace)\s+(?:called|named|titled|for|[:\-])\s+["“']?([A-Za-z0-9][A-Za-z0-9 _-]{1,40})["”']?/i)
      ?? t.match(/["“']([^"”']{3,40})["”']/);
    const fallback = t.replace(/^(create|add|new|start|make|open)\s+(a\s+)?(project|workspace)\s*/i, '').trim() || 'New Project';
    return { name: m?.[1]?.trim() ?? fallback };
  }

  if (tool === 'memory.write') {
    const content = t.replace(/^(please\s+)?(?:remember|note|don'?t forget(?: that)?|keep in mind(?: that)?)[:\s-]*/i, '').trim() || t;
    const type = /\b(prefer|like|favorite|always|never)\b/i.test(t) ? 'preference' : 'semantic';
    return { content, type, importance: type === 'preference' ? 8 : 5 };
  }

  if (tool === 'memory.search') {
    const q = t.replace(/^(what do you (know|remember)( about)?|recall|remind me( about)?|search memories? (for|about))[:\s]*/i, '').trim() || t;
    return { query: q, k: 5 };
  }

  if (tool === 'http.fetch') {
    const m = t.match(/https?:\/\/[^\s"'<>)]+/i);
    return m ? { url: m[0] } : {};
  }

  if (tool === 'notify') {
    const m = t.match(/["“']([^"”']{3,120})["”']/);
    const fallbackTitle = t.replace(/^(notify|alert|tell me|ping me( about)?|remind me( about)?)[:\s-]*/i, '').slice(0, 80) || 'Notification';
    const title = m?.[1] ?? fallbackTitle;
    return { title, message: t.slice(0, 300) };
  }

  if (tool === 'file.write') {
    const m = t.match(/(?:to|as|into)\s+["“']?([\w./-]+\.[a-z0-9]{1,8})["”']?/i);
    const content = t.replace(/^.*\b(?:content|with)\s*(?:being)?[:\s]*/i, '').trim();
    return { path: m?.[1] ?? `artifact-${Date.now()}.md`, content: content.length > 10 ? content : t };
  }

  if (tool === 'calc.eval') {
    const m = t.match(/[-+]?[\d.,\s]+(?:[+\-*/%][\d.,\s]+)+/);
    return m ? { expression: m[0].replace(/,/g, '').replace(/\s+/g, '') } : {};
  }

  if (tool === 'task.list') {
    const status = t.match(/\b(open|todo|pending)\b/i) ? 'todo' : t.match(/\b(in progress)\b/i) ? 'in_progress' : t.match(/\b(done|completed)\b/i) ? 'done' : undefined;
    return status ? { status } : {};
  }

  if (tool === 'task.update') {
    const m = t.match(/\b(?:task\s*)?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{8})\b/i);
    return m ? { task_id: m[1], status: 'done' } : { status: 'done' };
  }

  return {};
}

export function heuristicPlan(prompt: string, hint: unknown): Plan {
  // Arg extraction must run against the USER'S WORDS, not the composed context
  // blob (system prompt + memories + request) the router hands us.
  const userText = (hint && typeof hint === 'object' && typeof (hint as any).user_input === 'string')
    ? (hint as any).user_input : prompt;
  const steps: any[] = [];
  const seen = new Set<string>();
  for (const { re, step } of PLAN_TOOL_HINTS) {
    if (re.test(userText) && !seen.has(step.tool)) {
      seen.add(step.tool);
      steps.push({ kind: 'tool', tool: step.tool, args: { ...(step.args ?? {}), ...extractArgs(step.tool, userText) } });
    }
  }
  if (steps.length === 0) {
    // No tool matched → pure reasoning plan
    return {
      rationale: 'No tools matched; direct reasoning response (deterministic builtin model).',
      steps: [{ kind: 'model', capability: 'reasoning', prompt: 'Answer directly.', input_from: 'all' }],
    };
  }
  // Always finish with a synthesis step
  steps.push({ kind: 'model', capability: 'reasoning', prompt: 'Synthesize the final answer from the observations.', input_from: 'all' });
  return {
    rationale: `Heuristic plan: ${[...seen].join(', ')} then synthesize.`,
    steps,
  };
}

function summarize(text: string): string {
  const sentences = text.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+/).filter(s => s.trim().length > 0);
  if (sentences.length === 0) return '(nothing to summarize)';
  const keep = sentences.length <= 3 ? sentences : sentences.filter((_, i) => i % Math.ceil(sentences.length / 3) === 0).slice(0, 3);
  return keep.join(' ');
}

function reason(prompt: string): string {
  return [
    `Deterministic builtin reasoner (no external model configured).`,
    `Parsed request: ${prompt.slice(0, 400)}`,
    ``,
    `This kernel ships with the builtin provider so the full pipeline (agent → gateway → tool → memory → generation → event) works with zero external dependencies. Configure OPENAI_BASE_URL/KEY or OLLAMA_BASE_URL in .env to route reasoning through a real model — the router will pick it up automatically.`,
  ].join('\n');
}

// ─── OpenAI-compatible provider ─────────────────────────────────────────────
export class OpenAICompatProvider implements ModelProviderPort {
  id = 'openai-compat';
  name: string;
  kind = 'openai-compat' as const;

  constructor(private baseUrl: string, private apiKey: string, private models: string[], name = 'OpenAI-compatible') {
    this.name = name;
  }

  async healthy(): Promise<boolean> {
    try { await fetchJson(`${this.baseUrl}/models`, { method: 'GET', headers: this.headers() }, 8000); return true; }
    catch { return false; }
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  async listModels(): Promise<string[]> {
    const r = await fetchJson(`${this.baseUrl}/models`, { method: 'GET', headers: this.headers() }, 10000);
    return (r?.data ?? []).map((m: any) => m.id).filter((m: string) => typeof m === 'string');
  }

  async generate(req: ModelRequest, model_id: string): Promise<ModelResponse> {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      model: model_id.replace(/^openai-compat:/, ''),
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
      temperature: req.temperature ?? (req.capability === 'planning' ? 0.1 : 0.4),
      max_tokens: req.max_tokens ?? 1024,
    };
    if (req.capability === 'planning') {
      body.response_format = { type: 'json_object' };
    }
    const r = await fetchJson(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body),
    });
    const text = r?.choices?.[0]?.message?.content ?? '';
    return {
      text,
      plan: req.capability === 'planning' ? (parsePlanFromText(text) ?? undefined) : undefined,
      model_id: `openai-compat:${r?.model ?? model_id}`, provider_id: this.id,
      input_tokens: r?.usage?.prompt_tokens ?? estimateTokens(req.prompt),
      output_tokens: r?.usage?.completion_tokens ?? estimateTokens(text),
      latency_ms: Date.now() - t0,
    };
  }

  /** Phase 2: SSE streaming via /chat/completions stream:true. */
  async generateStream(req: ModelRequest, model_id: string, onToken: (delta: string) => void, signal?: AbortSignal): Promise<ModelResponse> {
    const t0 = Date.now();
    const body: Record<string, unknown> = {
      model: model_id.replace(/^openai-compat:/, ''),
      stream: true,
      stream_options: { include_usage: true },
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt },
      ],
      temperature: req.temperature ?? (req.capability === 'planning' ? 0.1 : 0.4),
      max_tokens: req.max_tokens ?? 1024,
    };
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let full = ''; let model = model_id; let usage: any = null;
    await readChunks(res, (j) => {
      if (j?.usage) usage = j.usage;
      if (j?.model) model = j.model;
      return j?.choices?.[0]?.delta?.content ?? null;
    }, (delta) => { full += delta; onToken(delta); }, signal);
    if (signal?.aborted) throw abortErr();
    return {
      text: full,
      plan: req.capability === 'planning' ? (parsePlanFromText(full) ?? undefined) : undefined,
      model_id: `openai-compat:${model}`, provider_id: this.id,
      input_tokens: usage?.prompt_tokens ?? estimateTokens(req.prompt),
      output_tokens: usage?.completion_tokens ?? estimateTokens(full),
      latency_ms: Date.now() - t0,
    };
  }
}

// ─── Ollama provider ────────────────────────────────────────────────────────
export class OllamaProvider implements ModelProviderPort {
  id = 'ollama';
  name = 'Ollama (local)';
  kind = 'ollama' as const;

  constructor(private baseUrl: string) {}

  async healthy(): Promise<boolean> {
    try { await fetchJson(`${this.baseUrl}/api/tags`, { method: 'GET' }, 5000); return true; }
    catch { return false; }
  }

  async listModels(): Promise<string[]> {
    const r = await fetchJson(`${this.baseUrl}/api/tags`, { method: 'GET' }, 8000);
    return (r?.models ?? []).map((m: any) => m.name).filter((n: string) => typeof n === 'string');
  }

  async generate(req: ModelRequest, model_id: string): Promise<ModelResponse> {
    const t0 = Date.now();
    const body = {
      model: model_id.replace(/^ollama:/, ''),
      stream: false,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt + (req.capability === 'planning' ? '\n\nRespond ONLY with a JSON object: {"rationale": "...", "steps": [{"kind": "tool", "tool": "...", "args": {...}} | {"kind": "model", "capability": "reasoning|writing|chat", "prompt": "..."}]}. Available tools: ' + PLANNER_TOOLS : '') },
      ],
      options: { temperature: req.temperature ?? (req.capability === 'planning' ? 0.1 : 0.4), num_predict: req.max_tokens ?? 1024 },
    };
    const r = await fetchJson(`${this.baseUrl}/api/chat`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }, 120000);
    const text = r?.message?.content ?? '';
    return {
      text,
      plan: req.capability === 'planning' ? (parsePlanFromText(text) ?? undefined) : undefined,
      model_id: `ollama:${body.model}`, provider_id: this.id,
      input_tokens: r?.prompt_eval_count ?? estimateTokens(req.prompt),
      output_tokens: r?.eval_count ?? estimateTokens(text),
      latency_ms: Date.now() - t0,
    };
  }

  /** Phase 2: ndjson streaming via /api/chat stream:true. */
  async generateStream(req: ModelRequest, model_id: string, onToken: (delta: string) => void, signal?: AbortSignal): Promise<ModelResponse> {
    const t0 = Date.now();
    const body = {
      model: model_id.replace(/^ollama:/, ''),
      stream: true,
      messages: [
        ...(req.system ? [{ role: 'system', content: req.system }] : []),
        { role: 'user', content: req.prompt + (req.capability === 'planning' ? '\n\nRespond ONLY with a JSON object: {"rationale": "...", "steps": [{"kind": "tool", "tool": "...", "args": {...}} | {"kind": "model", "capability": "reasoning|writing|chat", "prompt": "..."}]}. Available tools: ' + PLANNER_TOOLS : '') },
      ],
      options: { temperature: req.temperature ?? (req.capability === 'planning' ? 0.1 : 0.4), num_predict: req.max_tokens ?? 1024 },
    };
    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let full = ''; let inTok = 0; let outTok = 0;
    await readChunks(res, (j) => {
      if (j?.prompt_eval_count) inTok = j.prompt_eval_count;
      if (j?.eval_count) outTok = j.eval_count;
      return j?.message?.content ?? null;
    }, (delta) => { full += delta; onToken(delta); }, signal, 'nl');
    if (signal?.aborted) throw abortErr();
    return {
      text: full,
      plan: req.capability === 'planning' ? (parsePlanFromText(full) ?? undefined) : undefined,
      model_id: `ollama:${body.model}`, provider_id: this.id,
      input_tokens: inTok || estimateTokens(req.prompt),
      output_tokens: outTok || estimateTokens(full),
      latency_ms: Date.now() - t0,
    };
  }
}

// ─── Gemini provider (Generative Language API) ─────────────────────────────
export class GeminiProvider implements ModelProviderPort {
  id = 'gemini';
  name = 'Google Gemini';
  kind = 'gemini' as const;

  constructor(private apiKey: string, private baseUrl: string = 'https://generativelanguage.googleapis.com', private modelFilter: string[] = []) {}

  private url(method: string, model: string, extra = ''): string {
    return `${this.baseUrl}/v1beta/models/${model}:${method}?key=${this.apiKey}${extra}`;
  }

  async healthy(): Promise<boolean> {
    // Only a genuinely successful call counts as healthy — auth errors (400/401/403),
    // bad model ids (404) and network failures are all "down" for routing purposes.
    // Minimal VALID body (empty {} would 400 and false-negative a good key).
    const probe = JSON.stringify({ contents: [{ parts: [{ text: 'ping' }] }] });
    try { await fetchJson(this.url('generateContent', 'gemini-2.0-flash'), { method: 'POST', headers: this.headers(), body: probe }, 8000); return true; }
    catch { return false; }
  }

  private headers(): Record<string, string> { return { 'Content-Type': 'application/json' }; }

  async listModels(): Promise<string[]> {
    const r = await fetchJson(`${this.baseUrl}/v1beta/models?key=${this.apiKey}&pageSize=100`, { method: 'GET' }, 10000);
    const models: string[] = (r?.models ?? [])
      .map((m: any) => String(m?.name ?? '').replace(/^models\//, ''))
      .filter((n: string) => /^gemini-\d/.test(n) && !/embedding|aqa|image|tts|vision-only/i.test(n));
    const filtered = this.modelFilter.length ? models.filter(m => this.modelFilter.some(f => m.includes(f))) : models;
    return filtered.slice(0, 30);
  }

  private body(req: ModelRequest): string {
    return JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      generationConfig: {
        temperature: req.temperature ?? (req.capability === 'planning' ? 0.1 : 0.4),
        maxOutputTokens: req.max_tokens ?? 1024,
      },
    });
  }

  async generate(req: ModelRequest, model_id: string): Promise<ModelResponse> {
    const t0 = Date.now();
    const mid = model_id.replace(/^gemini:/, '');
    const r = await fetchJson(this.url('generateContent', mid), { method: 'POST', headers: this.headers(), body: this.body(req) }, 60000);
    const text = (r?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
    const usage = r?.usageMetadata ?? {};
    return {
      text,
      plan: req.capability === 'planning' ? (parsePlanFromText(text) ?? undefined) : undefined,
      model_id: `gemini:${mid}`, provider_id: this.id,
      input_tokens: usage.promptTokenCount ?? estimateTokens(req.prompt),
      output_tokens: usage.candidatesTokenCount ?? estimateTokens(text),
      latency_ms: Date.now() - t0,
    };
  }

  /** Phase 2: SSE streaming via streamGenerateContent?alt=sse. */
  async generateStream(req: ModelRequest, model_id: string, onToken: (delta: string) => void, signal?: AbortSignal): Promise<ModelResponse> {
    const t0 = Date.now();
    const mid = model_id.replace(/^gemini:/, '');
    const res = await fetch(this.url('streamGenerateContent', mid, '&alt=sse'), {
      method: 'POST', headers: this.headers(), body: this.body(req), signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    let full = ''; let usage: any = null;
    await readChunks(res, (j) => {
      if (j?.usageMetadata) usage = j.usageMetadata;
      return (j?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('') || null;
    }, (delta) => { full += delta; onToken(delta); }, signal);
    if (signal?.aborted) throw abortErr();
    return {
      text: full,
      plan: req.capability === 'planning' ? (parsePlanFromText(full) ?? undefined) : undefined,
      model_id: `gemini:${mid}`, provider_id: this.id,
      input_tokens: usage?.promptTokenCount ?? estimateTokens(req.prompt),
      output_tokens: usage?.candidatesTokenCount ?? estimateTokens(full),
      latency_ms: Date.now() - t0,
    };
  }
}

export const PLANNER_TOOLS = [
  'memory.write', 'memory.search', 'task.create', 'task.update', 'task.list',
  'project.create', 'http.fetch', 'file.write', 'shell.run', 'notify', 'calc.eval',
];

export function abortErr(): Error {
  const e = new Error('aborted');
  (e as any).aborted = true;
  return e;
}
function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
