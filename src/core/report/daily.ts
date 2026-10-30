/**
 * Relatório diário por gestor: nº de calls, nota média, % abaixo da barra, etapa mais fraca do
 * time, top 3 calls para olhar (críticas/churn) e próximos passos vencidos. Usa as mesmas
 * consultas com escopo do painel: cada gestor só vê o próprio time.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client";
import { calls, next_steps } from "../db/schema";
import type { Notificacao } from "../notify/index";
import { panelUrl } from "../notify/index";
import { getViewer, listCalls, type CallListItem } from "../queries";
import { localDay, parsePrazo } from "./prazo";

export type DailyReport = {
  gestor: { id: string; nome: string; slack: string; whatsapp: string };
  data: string; // YYYY-MM-DD
  playbook: string;
  barra: number;
  calls: number;
  analisadas: number;
  nota_media: number | null;
  abaixo_pct: number | null;
  criticas: number;
  por_closer: Array<{ nome: string; calls: number; nota_media: number | null; abaixo: number }>;
  etapa_mais_fraca: { id: string; falha_pct: number; n: number } | null;
  top: Array<{ id: string; lead: string; closer: string; nota: number | null; classificacao: string | null; churn_vermelho: number; motivo: string }>;
  vencidos: Array<{ call_id: string; lead: string; tarefa: string; responsavel: string | null; prazo: string; venceu_em: string }>;
  sem_prazo: number;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const dia = (c: CallListItem) => (c.data ? localDay(c.data) : "");

export async function buildDailyReport(
  db: Db,
  opts: { gestor: { id: string; nome: string; slack?: string; whatsapp?: string }; data: string; playbook: string; barra: number },
): Promise<DailyReport> {
  const viewer = await getViewer(db, opts.gestor.id);
  const todas = await listCalls(db, viewer, { playbook: opts.playbook });
  const doDia = todas.filter((c) => c.triage_status === "comercial" && dia(c) === opts.data);
  const analisadas = doDia.filter((c) => c.analysis?.nota != null);
  const notas = analisadas.map((c) => c.analysis!.nota!);

  const porCloser = new Map<string, CallListItem[]>();
  for (const c of doDia) porCloser.set(c.closer_nome ?? "—", [...(porCloser.get(c.closer_nome ?? "—") ?? []), c]);

  const etapas = new Map<string, { falhas: number; n: number }>();
  for (const c of analisadas)
    for (const e of c.analysis!.etapas) {
      const s = etapas.get(e.id) ?? { falhas: 0, n: 0 };
      s.n++;
      if (e.status !== "completo") s.falhas++;
      etapas.set(e.id, s);
    }
  const fraca = [...etapas].map(([id, s]) => ({ id, falha_pct: s.falhas / s.n, n: s.n })).sort((a, b) => b.falha_pct - a.falha_pct)[0] ?? null;

  const top = analisadas
    .filter((c) => c.analysis!.classificacao === "critica" || c.analysis!.churn_vermelho > 0)
    .sort((a, b) => b.analysis!.churn_vermelho - a.analysis!.churn_vermelho || (a.analysis!.nota ?? 0) - (b.analysis!.nota ?? 0))
    .slice(0, 3)
    .map((c) => ({
      id: c.id,
      lead: c.lead,
      closer: c.closer_nome ?? "—",
      nota: c.analysis!.nota,
      classificacao: c.analysis!.classificacao,
      churn_vermelho: c.analysis!.churn_vermelho,
      // A nota já aparece na linha: o motivo útil é o primeiro que não fala dela.
      motivo: c.analysis!.motivos.find((m) => !m.startsWith("Nota ")) ?? "",
    }));

  // Próximos passos vencidos: de qualquer call do time (não só do dia), ainda pendentes.
  const comerciais = todas.filter((c) => c.triage_status === "comercial");
  const ids = comerciais.map((c) => c.id);
  const steps = ids.length
    ? await db
        .select({ s: next_steps, data_hora: calls.data_hora, ingested_at: calls.ingested_at })
        .from(next_steps)
        .innerJoin(calls, eq(calls.id, next_steps.call_id))
        .where(and(inArray(next_steps.call_id, ids), eq(next_steps.status, "pendente")))
    : [];
  const lead = new Map(comerciais.map((c) => [c.id, c.lead]));
  const vencidos: DailyReport["vencidos"] = [];
  let semPrazo = 0;
  for (const { s, data_hora, ingested_at } of steps) {
    const quando = parsePrazo(s.prazo, data_hora ?? ingested_at);
    if (!quando) semPrazo++;
    else if (quando < opts.data)
      vencidos.push({ call_id: s.call_id, lead: lead.get(s.call_id) ?? "—", tarefa: s.tarefa, responsavel: s.responsavel, prazo: s.prazo ?? "", venceu_em: quando });
  }
  vencidos.sort((a, b) => a.venceu_em.localeCompare(b.venceu_em));

  return {
    gestor: { id: opts.gestor.id, nome: opts.gestor.nome, slack: opts.gestor.slack ?? "", whatsapp: opts.gestor.whatsapp ?? "" },
    data: opts.data,
    playbook: opts.playbook,
    barra: opts.barra,
    calls: doDia.length,
    analisadas: analisadas.length,
    nota_media: avg(notas),
    abaixo_pct: notas.length ? notas.filter((n) => n < opts.barra).length / notas.length : null,
    criticas: analisadas.filter((c) => c.analysis!.classificacao === "critica").length,
    por_closer: [...porCloser].map(([nome, cs]) => {
      const ns = cs.map((c) => c.analysis?.nota).filter((n): n is number => n != null);
      return { nome, calls: cs.length, nota_media: avg(ns), abaixo: ns.filter((n) => n < opts.barra).length };
    }).sort((a, b) => b.abaixo - a.abaixo || a.nome.localeCompare(b.nome)),
    etapa_mais_fraca: fraca,
    top,
    vencidos,
    sem_prazo: semPrazo,
  };
}

const ddmm = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const nota = (n: number | null) => (n == null ? "—" : String(Math.round(n)));

export function dailyNotification(r: DailyReport, stageName: (id: string) => string = (id) => id): Notificacao {
  const base = panelUrl();
  const resumo = r.calls
    ? `${r.calls} call(s), ${r.analisadas} analisada(s) · nota média ${nota(r.nota_media)} · ${pct(r.abaixo_pct)} abaixo da barra (${r.barra}) · ${r.criticas} crítica(s)`
    : "Nenhuma call comercial neste dia.";
  return {
    tipo: "relatorio_diario",
    destinatario: r.gestor,
    chave: `diario:${r.data}:${r.playbook}`,
    titulo: `Relatório diário ${ddmm(r.data)} — ${r.gestor.nome}`,
    resumo,
    secoes: [
      { titulo: "Por closer", itens: r.por_closer.map((c) => `${c.nome}: ${c.calls} call(s), nota ${nota(c.nota_media)}${c.abaixo ? `, ${c.abaixo} abaixo da barra` : ""}`) },
      { titulo: "Etapa mais fraca do time", itens: r.etapa_mais_fraca ? [`${stageName(r.etapa_mais_fraca.id)}: ${pct(r.etapa_mais_fraca.falha_pct)} das calls sem completar`] : [] },
      {
        titulo: "Para olhar primeiro",
        itens: r.top.map((t) => `${t.closer} com ${t.lead} — nota ${nota(t.nota)}${t.churn_vermelho ? `, churn vermelho ×${t.churn_vermelho}` : ""}${t.motivo ? `. ${t.motivo}` : ""}. ${base}/calls/${t.id}?playbook=${r.playbook}`),
      },
      {
        titulo: `Próximos passos vencidos (${r.vencidos.length})`,
        itens: [
          ...r.vencidos.slice(0, 8).map((v) => `${v.tarefa}${v.responsavel ? ` (${v.responsavel})` : ""} — venceu ${ddmm(v.venceu_em)} · ${v.lead}`),
          ...(r.vencidos.length > 8 ? [`… e mais ${r.vencidos.length - 8}`] : []),
          ...(r.sem_prazo ? [`${r.sem_prazo} passo(s) pendente(s) sem prazo definido`] : []),
        ],
      },
    ],
    links: [{ label: "Visão do time", url: `${base}/time?playbook=${r.playbook}` }],
    dados: r as unknown as Record<string, unknown>,
  };
}
