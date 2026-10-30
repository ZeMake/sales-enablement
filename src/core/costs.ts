/**
 * Custos (SPEC §9.6 e §12): por call, por dia, por closer e por etapa, com tokens com e sem cache.
 * `billing = assinatura` é custo EQUIVALENTE em API (saiu da cota do Claude Code); `api` é custo real.
 * Escopo: admin vê tudo (inclusive custos sem call); gestor/closer só os das calls que podem ver.
 */
import { eq } from "drizzle-orm";
import type { Db } from "./db/client";
import { calls, cost_log, people } from "./db/schema";
import { visibleCloserIds, type Viewer } from "./queries";
import { localDay } from "./report/prazo";

export type Tokens = { input: number; output: number; cache_read: number; cache_write: number };
export type Linha = { chave: string; label: string; usd: number; brl: number; chamadas: number; tokens: Tokens };

export type CostSummary = {
  total: { usd: number; brl: number; api_usd: number; assinatura_usd: number; chamadas: number; tokens: Tokens; cache_pct: number | null };
  por_call_media: { usd: number | null; calls: number };
  por_dia: Linha[];
  por_closer: Linha[];
  por_etapa: Linha[];
  por_modelo: Linha[];
  por_call: Array<Linha & { closer: string | null }>;
};

const zero = (): Tokens => ({ input: 0, output: 0, cache_read: 0, cache_write: 0 });

/** Fração da entrada que veio do cache (lida), sobre toda a entrada (normal + escrita + lida). */
export const cachePct = (t: Tokens) => {
  const entrada = t.input + t.cache_read + t.cache_write;
  return entrada ? t.cache_read / entrada : null;
};

export async function costSummary(db: Db, viewer: Viewer, f: { de?: string; ate?: string } = {}): Promise<CostSummary> {
  const ppl = await db.select().from(people);
  const scope = visibleCloserIds(viewer, ppl);
  const rows = await db
    .select({ c: cost_log, closer_id: calls.closer_id })
    .from(cost_log)
    .leftJoin(calls, eq(calls.id, cost_log.call_id));
  const nome = new Map(ppl.map((p) => [p.id, p.nome]));

  const visiveis = rows
    .filter((r) => (scope === "todos" ? true : r.closer_id != null && scope.includes(r.closer_id)))
    .map((r) => ({ ...r, dia: localDay(r.c.created_at) }))
    .filter((r) => (!f.de || r.dia >= f.de) && (!f.ate || r.dia <= f.ate));

  const agrupar = (key: (r: (typeof visiveis)[number]) => string, label: (k: string) => string = (k) => k): Linha[] => {
    const m = new Map<string, Linha>();
    for (const r of visiveis) {
      const k = key(r);
      const l = m.get(k) ?? { chave: k, label: label(k), usd: 0, brl: 0, chamadas: 0, tokens: zero() };
      l.usd += r.c.custo_usd;
      l.brl += r.c.custo_brl;
      l.chamadas++;
      l.tokens.input += r.c.tokens_input;
      l.tokens.output += r.c.tokens_output;
      l.tokens.cache_read += r.c.tokens_cache_read;
      l.tokens.cache_write += r.c.tokens_cache_write;
      m.set(k, l);
    }
    return [...m.values()];
  };

  const tokens = zero();
  for (const r of visiveis) {
    tokens.input += r.c.tokens_input;
    tokens.output += r.c.tokens_output;
    tokens.cache_read += r.c.tokens_cache_read;
    tokens.cache_write += r.c.tokens_cache_write;
  }
  const soma = (xs: typeof visiveis) => xs.reduce((a, r) => a + r.c.custo_usd, 0);
  const porCall = agrupar((r) => r.c.call_id ?? "(sem call)");
  const comCall = porCall.filter((l) => l.chave !== "(sem call)");
  const closerDaCall = new Map(visiveis.map((r) => [r.c.call_id ?? "(sem call)", r.closer_id]));

  return {
    total: {
      usd: soma(visiveis),
      brl: visiveis.reduce((a, r) => a + r.c.custo_brl, 0),
      api_usd: soma(visiveis.filter((r) => r.c.billing === "api")),
      assinatura_usd: soma(visiveis.filter((r) => r.c.billing === "assinatura")),
      chamadas: visiveis.length,
      tokens,
      cache_pct: cachePct(tokens),
    },
    por_call_media: { usd: comCall.length ? comCall.reduce((a, l) => a + l.usd, 0) / comCall.length : null, calls: comCall.length },
    por_dia: agrupar((r) => r.dia).sort((a, b) => a.chave.localeCompare(b.chave)),
    por_closer: agrupar((r) => r.closer_id ?? "(sem closer)", (k) => nome.get(k) ?? k).sort((a, b) => b.usd - a.usd),
    por_etapa: agrupar((r) => r.c.etapa).sort((a, b) => b.usd - a.usd),
    por_modelo: agrupar((r) => `${r.c.model} · ${r.c.billing}`).sort((a, b) => b.usd - a.usd),
    por_call: porCall
      .map((l) => ({ ...l, closer: (() => { const id = closerDaCall.get(l.chave); return id ? (nome.get(id) ?? id) : null; })() }))
      .sort((a, b) => b.usd - a.usd),
  };
}
