/**
 * Insights (SPEC §9.5 e §13): a nota tem relação com conversão? Só entram calls com desfecho
 * ganho/perdido. Tudo vem com o n de cada grupo; abaixo de N_MINIMO o grupo é marcado como amostra
 * pequena — correlação não é certeza, e com pouca amostra nem correlação é.
 */
import type { VerifiedAnalysis } from "./analysis/schema";
import type { Db } from "./db/client";
import { analyses } from "./db/schema";
import { listCalls, type Viewer } from "./queries";
import { inArray } from "drizzle-orm";

export const N_MINIMO = 30;

export type Grupo = { label: string; n: number; ganhas: number; conversao: number | null; pequeno: boolean };

export type Ponto = {
  call_id: string;
  nota: number;
  ganho: boolean;
  etapas: Array<{ id: string; status: string }>;
  reframe: boolean;
  custo_quantificado: boolean;
  case_momento: "a_pedido" | "proativo" | null;
};

export type PlaybookInsights = {
  playbook_id: string;
  n: number;
  quintis: Array<Grupo & { min: number; max: number }>;
  etapas: Array<{ id: string; completa: Grupo; nao: Grupo; diferenca: number | null }>;
  hipoteses: Array<{ id: string; titulo: string; grupos: Grupo[] }>;
  predicao: Predicao;
};

export type Predicao = { n: number; auc: number | null; correlacao: number | null; media_ganho: number | null; media_perdido: number | null };

export type Insights = {
  com_desfecho: number;
  sem_desfecho: number;
  em_andamento: number;
  playbooks: PlaybookInsights[];
  /** SPICED × Make nas mesmas calls (com as duas análises e desfecho). */
  comparacao: Array<{ playbook_id: string } & Predicao> | null;
};

export function grupo(label: string, xs: boolean[]): Grupo {
  const ganhas = xs.filter(Boolean).length;
  return { label, n: xs.length, ganhas, conversao: xs.length ? ganhas / xs.length : null, pequeno: xs.length < N_MINIMO };
}

/** Divide em até 5 faixas de tamanho parecido, ordenadas pela nota. */
export function quintis(pts: Array<{ nota: number; ganho: boolean }>): Array<Grupo & { min: number; max: number }> {
  const s = [...pts].sort((a, b) => a.nota - b.nota);
  const k = Math.min(5, s.length);
  const out = [];
  for (let i = 0; i < k; i++) {
    const fatia = s.slice(Math.round((i * s.length) / k), Math.round(((i + 1) * s.length) / k));
    const min = Math.round(fatia[0].nota);
    const max = Math.round(fatia.at(-1)!.nota);
    out.push({ ...grupo(min === max ? `${min}` : `${min}–${max}`, fatia.map((p) => p.ganho)), min, max });
  }
  return out;
}

/**
 * AUC: chance de uma call ganha ter nota maior que uma perdida (0,5 = moeda; 1 = separa perfeito).
 * Correlação ponto-bisserial entre nota e ganho.
 */
export function predicao(pts: Array<{ nota: number; ganho: boolean }>): Predicao {
  const g = pts.filter((p) => p.ganho).map((p) => p.nota);
  const l = pts.filter((p) => !p.ganho).map((p) => p.nota);
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  let auc: number | null = null;
  if (g.length && l.length) {
    let s = 0;
    for (const a of g) for (const b of l) s += a > b ? 1 : a === b ? 0.5 : 0;
    auc = s / (g.length * l.length);
  }
  let correlacao: number | null = null;
  const n = pts.length;
  if (g.length && l.length) {
    const m = mean(pts.map((p) => p.nota))!;
    const sd = Math.sqrt(pts.reduce((a, p) => a + (p.nota - m) ** 2, 0) / n);
    correlacao = sd ? ((mean(g)! - mean(l)!) / sd) * Math.sqrt((g.length / n) * (l.length / n)) : 0;
  }
  return { n, auc, correlacao, media_ganho: mean(g), media_perdido: mean(l) };
}

export function playbookInsights(playbook_id: string, stageIds: string[], pts: Ponto[]): PlaybookInsights {
  const etapas = stageIds.map((id) => {
    const completa = grupo("completa", pts.filter((p) => p.etapas.find((e) => e.id === id)?.status === "completo").map((p) => p.ganho));
    const nao = grupo("não completa", pts.filter((p) => p.etapas.find((e) => e.id === id)?.status !== "completo").map((p) => p.ganho));
    return { id, completa, nao, diferenca: completa.conversao != null && nao.conversao != null ? completa.conversao - nao.conversao : null };
  });
  const por = (f: (p: Ponto) => boolean) => pts.filter(f).map((p) => p.ganho);
  return {
    playbook_id,
    n: pts.length,
    quintis: quintis(pts),
    etapas,
    hipoteses: [
      { id: "reframe", titulo: "Reframe (reposicionou a dor do lead)", grupos: [grupo("houve reframe", por((p) => p.reframe)), grupo("sem reframe", por((p) => !p.reframe))] },
      { id: "custo", titulo: "Custo de não resolver quantificado", grupos: [grupo("quantificado", por((p) => p.custo_quantificado)), grupo("não quantificado", por((p) => !p.custo_quantificado))] },
      {
        id: "case",
        titulo: "Case mostrado",
        grupos: [grupo("a pedido do lead", por((p) => p.case_momento === "a_pedido")), grupo("proativo", por((p) => p.case_momento === "proativo")), grupo("sem case", por((p) => !p.case_momento))],
      },
    ],
    predicao: predicao(pts),
  };
}

export async function buildInsights(db: Db, viewer: Viewer, playbooks: Array<{ id: string; etapas: Array<{ id: string }> }>): Promise<Insights> {
  const calls = (await listCalls(db, viewer)).filter((c) => c.triage_status === "comercial");
  const fechadas = calls.filter((c) => c.desfecho === "ganho" || c.desfecho === "perdido");
  const ids = fechadas.map((c) => c.id);
  const an = ids.length ? await db.select().from(analyses).where(inArray(analyses.call_id, ids)) : [];
  // Análise mais recente por call × playbook
  const latest = new Map<string, (typeof an)[number]>();
  for (const a of an.sort((x, y) => x.created_at.localeCompare(y.created_at))) latest.set(`${a.call_id}|${a.playbook_id}`, a);
  const ganho = new Map(fechadas.map((c) => [c.id, c.desfecho === "ganho"]));

  const pontos = (pb: string): Ponto[] =>
    ids.flatMap((id) => {
      const a = latest.get(`${id}|${pb}`);
      if (!a || a.nota_aderencia == null) return [];
      const v = a.result as unknown as VerifiedAnalysis;
      return [{
        call_id: id, nota: a.nota_aderencia, ganho: ganho.get(id)!, etapas: v.etapas.map((e) => ({ id: e.id, status: e.status })),
        reframe: !!v.reframe?.ocorreu, custo_quantificado: !!v.custo_da_inacao?.quantificado, case_momento: v.cases?.momento ?? null,
      }];
    });

  const porPb = playbooks.map((pb) => playbookInsights(pb.id, pb.etapas.map((e) => e.id), pontos(pb.id)));
  let comparacao: Insights["comparacao"] = null;
  if (playbooks.length >= 2) {
    const ambos = ids.filter((id) => playbooks.every((pb) => latest.get(`${id}|${pb.id}`)?.nota_aderencia != null));
    comparacao = playbooks.map((pb) => ({ playbook_id: pb.id, ...predicao(pontos(pb.id).filter((p) => ambos.includes(p.call_id))) }));
  }
  return {
    com_desfecho: fechadas.length,
    sem_desfecho: calls.filter((c) => !c.desfecho).length,
    em_andamento: calls.filter((c) => c.desfecho === "em_andamento").length,
    playbooks: porPb,
    comparacao,
  };
}
