/**
 * Preços em US$ por milhão de tokens (tabela de preços da Anthropic, set/2026).
 * cache_write = escrita de cache de 5 min (1,25× input). Batch API cobra 50%.
 */
export const PRICING: Record<string, { input: number; output: number; cache_read: number; cache_write: number }> = {
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2, cache_write: 2.5 },
  "claude-haiku-4-5": { input: 1, output: 5, cache_read: 0.1, cache_write: 1.25 },
};

export type Usage = {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
};

export function costUsd(model: string, u: Usage, opts: { batch?: boolean } = {}): number {
  const p = PRICING[model];
  if (!p) throw new Error(`Sem preço cadastrado para o modelo ${model} (src/core/llm/pricing.ts)`);
  const usd =
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      (u.cache_read_input_tokens ?? 0) * p.cache_read +
      (u.cache_creation_input_tokens ?? 0) * p.cache_write) /
    1_000_000;
  return opts.batch ? usd / 2 : usd;
}

export const usdBrl = () => Number(process.env.USD_BRL ?? "5.40");
