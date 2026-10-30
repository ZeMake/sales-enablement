import Anthropic from "@anthropic-ai/sdk";
import type { Db } from "../db/client";
import { cost_log } from "../db/schema";
import { usdBrl, type Usage } from "./pricing";

let client: Anthropic | undefined;

/** O SDK resolve credenciais sozinho (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN ou perfil do `ant`). */
export function getClient(): Anthropic {
  return (client ??= new Anthropic());
}

export function lightModel(): string {
  const m = process.env.LIGHT_MODEL;
  if (!m) throw new Error("LIGHT_MODEL não definido no .env");
  return m;
}

export function analysisModel(): string {
  const m = process.env.ANALYSIS_MODEL;
  if (!m) throw new Error("ANALYSIS_MODEL não definido no .env");
  return m;
}

export async function logCost(
  db: Db,
  entry: { call_id?: string; etapa: string; model: string; usage: Usage; usd: number; billing: string; batch?: boolean },
): Promise<{ usd: number; brl: number }> {
  const brl = entry.usd * usdBrl();
  await db.insert(cost_log).values({
    call_id: entry.call_id,
    etapa: entry.etapa,
    model: entry.model,
    billing: entry.billing,
    batch: entry.batch ?? false,
    tokens_input: entry.usage.input_tokens,
    tokens_output: entry.usage.output_tokens,
    tokens_cache_read: entry.usage.cache_read_input_tokens ?? 0,
    tokens_cache_write: entry.usage.cache_creation_input_tokens ?? 0,
    custo_usd: entry.usd,
    custo_brl: brl,
  });
  return { usd: entry.usd, brl };
}
