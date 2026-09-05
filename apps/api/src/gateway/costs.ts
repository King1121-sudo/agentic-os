/**
 * Model cost registry — approximate PUBLISHED LIST PRICES (USD per 1M tokens)
 * for common hosted models. Seeded into the models table at registration time
 * so the generations ledger can compute cost.
 *
 * These are approximations for cost *tracking*, not billing: providers change
 * prices and hosts discount. Order matters — more specific patterns first
 * (e.g. gpt-4o-mini before gpt-4o, since "gpt-4o" is a substring).
 */

export interface ModelCosts { in: number; out: number }

const COST_TABLE: { re: RegExp; in: number; out: number }[] = [
  // OpenAI (order: most specific id first)
  { re: /gpt-4o-mini/, in: 0.15, out: 0.60 },
  { re: /gpt-4\.1-nano/, in: 0.10, out: 0.40 },
  { re: /gpt-4\.1-mini/, in: 0.40, out: 1.60 },
  { re: /gpt-4\.1/, in: 2.00, out: 8.00 },
  { re: /gpt-4o/, in: 2.50, out: 10.00 },
  { re: /gpt-4-turbo/, in: 10.00, out: 30.00 },
  { re: /gpt-3\.5/, in: 0.50, out: 1.50 },
  { re: /o1-preview/, in: 15.00, out: 60.00 },
  { re: /o1-mini/, in: 1.10, out: 4.40 },
  { re: /\bo1\b/, in: 15.00, out: 60.00 },
  { re: /o3-mini/, in: 1.10, out: 4.40 },
  { re: /o4-mini/, in: 1.10, out: 4.40 },
  { re: /\bo3\b/, in: 2.00, out: 8.00 },
  // Google Gemini
  { re: /gemini-2\.5-flash-lite/, in: 0.10, out: 0.40 },
  { re: /gemini-2\.5-flash/, in: 0.30, out: 2.50 },
  { re: /gemini-2\.5-pro/, in: 1.25, out: 10.00 },
  { re: /gemini-2\.0-flash-lite/, in: 0.075, out: 0.30 },
  { re: /gemini-2\.0-flash/, in: 0.10, out: 0.40 },
  { re: /gemini-1\.5-flash/, in: 0.075, out: 0.30 },
  { re: /gemini-1\.5-pro/, in: 1.25, out: 5.00 },
  // Anthropic (when fronted by an OpenAI-compatible proxy)
  { re: /claude-3-5-haiku|claude-3\.5-haiku/, in: 0.80, out: 4.00 },
  { re: /claude-3-5-sonnet|claude-3\.5-sonnet/, in: 3.00, out: 15.00 },
  { re: /claude-3-opus/, in: 15.00, out: 75.00 },
  // DeepSeek / Meta / Mistral / Qwen (hosted list prices vary by provider)
  { re: /deepseek-r1/, in: 0.55, out: 2.19 },
  { re: /deepseek-chat|deepseek-v3/, in: 0.27, out: 1.10 },
  { re: /llama-3\.3-70b/, in: 0.59, out: 0.79 },
  { re: /llama-3\.1-8b/, in: 0.05, out: 0.08 },
  { re: /llama-3\.1-70b/, in: 0.58, out: 0.79 },
  { re: /mixtral-8x7b/, in: 0.24, out: 0.24 },
  { re: /qwen2\.5-72b/, in: 0.35, out: 0.40 },
];

/** Look up approximate list-price costs for a model id. null when unknown. */
export function lookupCosts(_providerKind: string, modelId: string): ModelCosts | null {
  const m = modelId.toLowerCase();
  for (const row of COST_TABLE) {
    if (row.re.test(m)) return { in: row.in, out: row.out };
  }
  return null;
}
