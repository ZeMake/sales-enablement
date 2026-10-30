/**
 * Nota de aderência validada.
 *
 * 1. A nota vem SÓ do status de cada etapa (completo 10 · parcial 5 · ausente 0, com os pesos do
 *    playbook). A nota 0–10 que o Opus dá dentro do status não entra: é a parte que nada confere.
 * 2. Status final de cada etapa, nesta ordem: revisão humana (calibração) → Opus quando o Jev
 *    concorda → em revisão quando o Jev discorda.
 * 3. Etapa em revisão: a nota usa o status do Opus, mas a call mostra a faixa entre o status do
 *    Opus e o do Jev, e o selo fica "provisória" até alguém decidir.
 * 4. Churn vermelho só torna a call crítica se o Jev confirmar; vermelho que o Jev não vê vira atenção.
 */
import { and, eq } from "drizzle-orm";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { analyses, calibration_labels, calls, reliability, stage_results } from "../db/schema";
import type { Playbook } from "../playbook";
import { classify, type Classificacao } from "./classify";
import type { VerifiedAnalysis } from "./schema";

export const PONTOS: Record<string, number> = { completo: 10, parcial: 5, ausente: 0 };
export type Status = "completo" | "parcial" | "ausente";
export type Validacao = "validada" | "provisoria" | "sem_jev";

/** Média ponderada dos pontos de cada status × 10 (0–100). */
export function notaPorStatus(status: Record<string, string>, playbook: Playbook): number {
  const total = playbook.etapas.reduce((a, e) => a + e.peso, 0);
  const soma = playbook.etapas.reduce((a, e) => a + e.peso * (PONTOS[status[e.id]] ?? 0), 0);
  return Math.round((soma / total) * 100) / 10;
}

export type EtapaFinal = {
  id: string;
  opus: Status;
  jev?: Status;
  humano?: Status;
  /** Status que vale; null = em revisão (Opus e Jev discordam e ninguém decidiu). */
  final: Status | null;
  fonte: "humano" | "concordancia" | "sem_jev" | "revisao";
};

export function consolidarEtapas(
  etapas: Array<{ id: string; status: string }>,
  jev: Array<{ ref: string; jev: string; nivel: string }>,
  humano: Array<{ stage_id: string; status: string }>,
): EtapaFinal[] {
  return etapas.map((e) => {
    const opus = e.status as Status;
    const h = humano.find((x) => x.stage_id === e.id)?.status as Status | undefined;
    const j = jev.find((x) => x.ref === e.id);
    if (h) return { id: e.id, opus, jev: j?.jev as Status | undefined, humano: h, final: h, fonte: "humano" };
    if (!j) return { id: e.id, opus, final: opus, fonte: "sem_jev" };
    if (j.nivel !== "divergente") return { id: e.id, opus, jev: j.jev as Status, final: opus, fonte: "concordancia" };
    return { id: e.id, opus, jev: j.jev as Status, final: null, fonte: "revisao" };
  });
}

export function validarNota(finais: EtapaFinal[], playbook: Playbook) {
  const base = Object.fromEntries(finais.map((f) => [f.id, f.final ?? f.opus]));
  const baixo = { ...base };
  const alto = { ...base };
  for (const f of finais.filter((x) => x.final === null && x.jev)) {
    const [lo, hi] = [f.opus, f.jev!].sort((a, b) => PONTOS[a] - PONTOS[b]);
    baixo[f.id] = lo;
    alto[f.id] = hi;
  }
  const em_revisao = finais.filter((f) => f.final === null).map((f) => f.id);
  const validacao: Validacao = finais.some((f) => f.fonte === "sem_jev") ? "sem_jev" : em_revisao.length ? "provisoria" : "validada";
  return { nota: notaPorStatus(base, playbook), nota_min: notaPorStatus(baixo, playbook), nota_max: notaPorStatus(alto, playbook), validacao, em_revisao };
}

/**
 * Recalcula nota, faixa, selo e classificação de uma análise com o que existe hoje (Opus, Jev,
 * revisão humana). Sem IA: roda depois da análise, do Jev, da calibração e no `pnpm reclassify`.
 */
export async function recompute(
  db: Db,
  cfg: Config,
  analysisId: string,
  playbook: Playbook,
  opts: { dryRun?: boolean } = {},
): Promise<{ nota: number; nota_min: number; nota_max: number; validacao: Validacao; em_revisao: string[]; classificacao: Classificacao; motivos: string[] }> {
  const row = await db.select().from(analyses).where(eq(analyses.id, analysisId)).get();
  if (!row?.result) throw new Error(`Análise ${analysisId} não encontrada`);
  const a = row.result as unknown as VerifiedAnalysis;
  const call = await db.select({ tempo: calls.tempo_estimado }).from(calls).where(eq(calls.id, row.call_id)).get();
  const ctx = { talkRatioCloser: row.talk_ratio_closer ?? 0, tempoEstimado: call?.tempo ?? true };
  const rel = await db.select().from(reliability).where(eq(reliability.analysis_id, analysisId));
  const labels = await db
    .select()
    .from(calibration_labels)
    .where(and(eq(calibration_labels.call_id, row.call_id), eq(calibration_labels.playbook_id, row.playbook_id)))
    .orderBy(calibration_labels.created_at);

  // Mais recente primeiro: com mais de um avaliador, vale a última revisão.
  const finais = consolidarEtapas(a.etapas, rel.filter((r) => r.kind === "etapa"), [...labels].reverse());
  const v = validarNota(finais, playbook);
  const churnJev = Object.fromEntries(rel.filter((r) => r.kind === "churn").map((r) => [Number(r.ref), r.nivel]));
  const etapasFinais = a.etapas.map((e) => ({ ...e, status: finais.find((f) => f.id === e.id)?.final ?? e.status }));
  const { classificacao, motivos } = classify({ ...a, etapas: etapasFinais, nota_aderencia_0a100: v.nota }, { ...ctx, churnJev }, cfg.rules.classificacao);
  if (v.em_revisao.length) motivos.push(`Nota provisória: ${v.em_revisao.length} etapa(s) em revisão (${v.em_revisao.join(", ")}) — faixa ${Math.round(v.nota_min)}–${Math.round(v.nota_max)}`);

  if (!opts.dryRun)
    await db.transaction(async (tx) => {
      await tx
        .update(analyses)
        .set({
          nota_aderencia: v.nota, nota_min: v.nota_min, nota_max: v.nota_max, validacao: v.validacao, etapas_em_revisao: v.em_revisao,
          classificacao, motivos, result: { ...a, nota_aderencia_0a100: v.nota } as unknown as Record<string, unknown>,
        })
        .where(eq(analyses.id, analysisId));
      for (const f of finais) {
        const st = f.final ?? f.opus;
        await tx.update(stage_results).set({ status: st, nota: PONTOS[st] }).where(and(eq(stage_results.analysis_id, analysisId), eq(stage_results.stage_id, f.id)));
      }
    });
  return { ...v, classificacao, motivos };
}
