/**
 * Consultas de leitura com escopo por papel. Usadas pelo painel e, no futuro, pelo servidor MCP
 * (listar_calls, detalhar_call, resumo_closer, resumo_time, calls_criticas).
 */
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { VerifiedAnalysis } from "./analysis/schema";
import type { Db } from "./db/client";
import { analyses, calls, churn_flags, jobs, next_steps, notifications, people, reliability, segments, stage_results } from "./db/schema";
import type { CallMetrics, Segment } from "./types";

export type Viewer = { id: string; papeis: string[] };
type PersonRow = typeof people.$inferSelect;
type CallRow = typeof calls.$inferSelect;
type AnalysisRow = typeof analyses.$inferSelect;

/** Closers que o viewer pode ver: admin → todos; gestor → os que têm ele como gestor; closer → ele mesmo. */
export function visibleCloserIds(viewer: Viewer, all: PersonRow[]): string[] | "todos" {
  if (viewer.papeis.includes("admin")) return "todos";
  const ids = new Set<string>();
  if (viewer.papeis.includes("gestor"))
    for (const p of all) if (p.gestores.includes(viewer.id)) ids.add(p.id);
  if (viewer.papeis.includes("closer")) ids.add(viewer.id);
  return [...ids];
}

async function scopedCalls(db: Db, viewer: Viewer): Promise<CallRow[]> {
  const all = await db.select().from(people);
  const scope = visibleCloserIds(viewer, all);
  if (scope === "todos") return db.select().from(calls);
  if (!scope.length) return [];
  return db.select().from(calls).where(inArray(calls.closer_id, scope));
}

/** Playbook padrão: o que tem mais calls analisadas (empate → playbook da Make). */
export async function mostAnalyzedPlaybook(db: Db, playbookIds: string[]): Promise<string> {
  const counts = await db
    .select({ id: analyses.playbook_id, n: sql<number>`count(distinct ${analyses.call_id})` })
    .from(analyses)
    .groupBy(analyses.playbook_id);
  const n = (id: string) => counts.find((c) => c.id === id)?.n ?? 0;
  const ranked = [...playbookIds].sort((a, b) => n(b) - n(a) || Number(b === "make-closer") - Number(a === "make-closer"));
  return ranked[0] ?? "spiced";
}

export async function getPeople(db: Db) {
  return db.select().from(people).orderBy(asc(people.nome));
}

export async function getViewer(db: Db, id: string): Promise<Viewer> {
  const p = await db.select().from(people).where(eq(people.id, id)).get();
  if (!p) throw new Error(`Pessoa ${id} não existe em team.yaml`);
  return { id: p.id, papeis: p.papeis };
}

export type StageChip = { id: string; status: string; nota: number | null };

export type CallListItem = {
  id: string;
  data: string | null;
  closer_id: string | null;
  closer_nome: string | null;
  lead: string;
  produto: string | null;
  tipo_call: string | null;
  desfecho: string | null;
  triage_status: string;
  fala_closer: number | null;
  tempo_estimado: boolean;
  duracao_seg: number | null;
  analysis?: {
    id: string;
    playbook_id: string;
    nota: number | null;
    nota_min: number | null;
    nota_max: number | null;
    validacao: string | null;
    classificacao: string | null;
    motivos: string[];
    etapas: StageChip[];
    churn_vermelho: number;
    churn_amarelo: number;
  };
};

export type CallFilters = {
  playbook?: string;
  closer?: string;
  produto?: string;
  desfecho?: string;
  status?: string; // ok | atencao | critica | nao_analisada
  churn?: boolean;
  de?: string; // YYYY-MM-DD
  ate?: string;
};

const callDate = (c: CallRow) => c.data_hora ?? c.ingested_at;

export function leadName(c: CallRow): string {
  if (c.lead_nome) return c.lead_nome;
  return Object.entries(c.speaker_roles).filter(([, r]) => r === "cliente").map(([s]) => s).join(", ") || "—";
}

/** Lista de calls com a análise do playbook escolhido. */
export async function listCalls(db: Db, viewer: Viewer, f: CallFilters = {}): Promise<CallListItem[]> {
  const [rows, ppl] = await Promise.all([scopedCalls(db, viewer), getPeople(db)]);
  const ids = rows.map((r) => r.id);
  const an = ids.length
    ? await db.select().from(analyses).where(and(inArray(analyses.call_id, ids), f.playbook ? eq(analyses.playbook_id, f.playbook) : undefined))
    : [];
  // Mais recente por call (se houver versões de prompt diferentes).
  const byCall = new Map<string, AnalysisRow>();
  for (const a of an.sort((x, y) => x.created_at.localeCompare(y.created_at))) byCall.set(a.call_id, a);
  const aIds = [...byCall.values()].map((a) => a.id);
  const [stages, churnAll, rel] = aIds.length
    ? await Promise.all([
        db.select().from(stage_results).where(inArray(stage_results.analysis_id, aIds)),
        db.select().from(churn_flags).where(inArray(churn_flags.analysis_id, aIds)).orderBy(asc(churn_flags.id)),
        db.select({ analysis_id: reliability.analysis_id, ref: reliability.ref, nivel: reliability.nivel }).from(reliability).where(and(inArray(reliability.analysis_id, aIds), eq(reliability.kind, "churn"))),
      ])
    : [[], [], []];
  // Só conta risco que o Jev não contestou (mesma regra da classificação); a posição na análise é o ref do Jev.
  const divergente = new Set(rel.filter((r) => r.nivel === "divergente").map((r) => `${r.analysis_id}|${r.ref}`));
  const posicao = new Map<string, number>();
  const churn = churnAll.filter((f) => {
    const i = posicao.get(f.analysis_id) ?? 0;
    posicao.set(f.analysis_id, i + 1);
    return !divergente.has(`${f.analysis_id}|${i}`);
  });
  const nome = new Map(ppl.map((p) => [p.id, p.nome]));

  const items = rows.map<CallListItem>((c) => {
    const a = byCall.get(c.id);
    const m = c.metrics as unknown as CallMetrics | null;
    return {
      id: c.id,
      data: callDate(c),
      closer_id: c.closer_id,
      closer_nome: c.closer_id ? (nome.get(c.closer_id) ?? c.closer_id) : null,
      lead: leadName(c),
      produto: c.produto,
      tipo_call: c.tipo_call,
      desfecho: c.desfecho,
      triage_status: c.triage_status,
      fala_closer: m?.fala_pct.closer ?? null,
      tempo_estimado: c.tempo_estimado,
      duracao_seg: c.duration_sec,
      analysis: a && {
        id: a.id,
        playbook_id: a.playbook_id,
        nota: a.nota_aderencia,
        nota_min: a.nota_min,
        nota_max: a.nota_max,
        validacao: a.validacao,
        classificacao: a.classificacao,
        motivos: a.motivos ?? [],
        etapas: stages.filter((s) => s.analysis_id === a.id).map((s) => ({ id: s.stage_id, status: s.status, nota: s.nota })),
        churn_vermelho: churn.filter((x) => x.analysis_id === a.id && x.severidade === "vermelho").length,
        churn_amarelo: churn.filter((x) => x.analysis_id === a.id && x.severidade === "amarelo").length,
      },
    };
  });

  return items
    .filter((i) => !f.closer || i.closer_id === f.closer)
    .filter((i) => !f.produto || i.produto === f.produto)
    .filter((i) => !f.desfecho || (f.desfecho === "sem" ? !i.desfecho : i.desfecho === f.desfecho))
    .filter((i) => !f.status || (f.status === "nao_analisada" ? !i.analysis : i.analysis?.classificacao === f.status))
    .filter((i) => !f.churn || (i.analysis && i.analysis.churn_vermelho + i.analysis.churn_amarelo > 0))
    .filter((i) => !f.de || (i.data ?? "") >= f.de)
    .filter((i) => !f.ate || (i.data ?? "").slice(0, 10) <= f.ate)
    .sort((a, b) => (b.data ?? "").localeCompare(a.data ?? "") || a.id.localeCompare(b.id));
}

export type CallDetail = {
  call: CallRow;
  closer_nome: string | null;
  lead: string;
  segments: Segment[];
  metrics: CallMetrics | null;
  analyses: Array<Pick<AnalysisRow, "id" | "playbook_id" | "nota_aderencia" | "classificacao" | "prompt_version" | "created_at">>;
  analysis?: AnalysisRow & { result: VerifiedAnalysis };
  nextSteps: Array<typeof next_steps.$inferSelect>;
  /** Segundo julgamento (Jev) de cada etapa, risco e objeção da análise escolhida; vazio se não rodou. */
  reliability: ReliabilityRow[];
  /** Status final de cada etapa (já resolvido com Jev e revisão humana): base da composição da nota. */
  stages: Array<{ stage_id: string; status: string }>;
};

export type ReliabilityRow = Pick<typeof reliability.$inferSelect, "kind" | "ref" | "opus" | "jev" | "prob" | "nivel" | "contexto" | "model">;

/** Detalhe de uma call. Retorna undefined se não existir ou estiver fora do escopo do viewer. */
export async function getCallDetail(db: Db, viewer: Viewer, id: string, playbook?: string): Promise<CallDetail | undefined> {
  const call = (await scopedCalls(db, viewer)).find((c) => c.id === id);
  if (!call) return undefined;
  const [segs, an, steps, ppl] = await Promise.all([
    db.select().from(segments).where(eq(segments.call_id, id)).orderBy(asc(segments.idx)),
    db.select().from(analyses).where(eq(analyses.call_id, id)),
    db.select().from(next_steps).where(eq(next_steps.call_id, id)).orderBy(asc(next_steps.id)),
    getPeople(db),
  ]);
  const sorted = an.sort((a, b) => b.created_at.localeCompare(a.created_at));
  const chosen = sorted.find((a) => a.playbook_id === playbook) ?? sorted.find((a) => a.playbook_id === "make-closer") ?? sorted[0];
  const rel = chosen
    ? await db
        .select({ kind: reliability.kind, ref: reliability.ref, opus: reliability.opus, jev: reliability.jev, prob: reliability.prob, nivel: reliability.nivel, contexto: reliability.contexto, model: reliability.model })
        .from(reliability)
        .where(eq(reliability.analysis_id, chosen.id))
    : [];
  return {
    call,
    closer_nome: ppl.find((p) => p.id === call.closer_id)?.nome ?? call.closer_id,
    lead: leadName(call),
    segments: segs.map((s) => ({
      idx: s.idx, speaker: s.speaker, role: s.role as Segment["role"], start: s.start ?? undefined, end: s.end ?? undefined,
      text: s.text, flags: (s.flags ?? undefined) as Segment["flags"],
    })),
    metrics: call.metrics as unknown as CallMetrics | null,
    analyses: sorted.map(({ id, playbook_id, nota_aderencia, classificacao, prompt_version, created_at }) => ({ id, playbook_id, nota_aderencia, classificacao, prompt_version, created_at })),
    analysis: chosen as (AnalysisRow & { result: VerifiedAnalysis }) | undefined,
    nextSteps: steps,
    reliability: rel,
    stages: chosen
      ? await db.select({ stage_id: stage_results.stage_id, status: stage_results.status }).from(stage_results).where(eq(stage_results.analysis_id, chosen.id))
      : [],
  };
}

export type CloserSummary = {
  closer: PersonRow;
  calls: CallListItem[];
  analisadas: number;
  nota_media: number | null;
  abaixo_da_barra_pct: number | null;
  fala_media: number | null;
  perguntas_media: number | null;
  conversao: { ganhas: number; com_desfecho: number };
  criticas: number;
  cobertura: Array<{ id: string; completo: number; parcial: number; ausente: number; nota_media: number }>;
  temas_coaching: Array<{ tema: string; vezes: number; exemplo: string }>;
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export async function closerSummary(db: Db, viewer: Viewer, closerId: string, playbook: string, barra: number): Promise<CloserSummary | undefined> {
  const closer = (await getPeople(db)).find((p) => p.id === closerId);
  if (!closer) return undefined;
  const list = await listCalls(db, viewer, { closer: closerId, playbook });
  if (!list.length && !viewer.papeis.includes("admin") && viewer.id !== closerId) return undefined;
  const analisadas = list.filter((c) => c.analysis?.nota != null);
  const notas = analisadas.map((c) => c.analysis!.nota!);
  const segIds = list.map((c) => c.id);
  const metrics = segIds.length ? await db.select({ id: calls.id, metrics: calls.metrics }).from(calls).where(inArray(calls.id, segIds)) : [];

  const stageAgg = new Map<string, { completo: number; parcial: number; ausente: number; notas: number[] }>();
  for (const c of analisadas)
    for (const e of c.analysis!.etapas) {
      const s = stageAgg.get(e.id) ?? { completo: 0, parcial: 0, ausente: 0, notas: [] };
      s[e.status as "completo" | "parcial" | "ausente"]++;
      s.notas.push(e.nota ?? 0);
      stageAgg.set(e.id, s);
    }

  // Temas de coaching: a melhoria nº 1 de cada call, agrupada pela etapa mais fraca daquela call.
  const aIds = analisadas.map((c) => c.analysis!.id);
  const results = aIds.length ? await db.select({ id: analyses.id, result: analyses.result }).from(analyses).where(inArray(analyses.id, aIds)) : [];
  const temas = new Map<string, { vezes: number; exemplo: string }>();
  for (const r of results) {
    const v = r.result as unknown as VerifiedAnalysis;
    const pior = [...v.etapas].sort((a, b) => a.nota_0a10 - b.nota_0a10)[0];
    if (!pior) continue;
    const t = temas.get(pior.id) ?? { vezes: 0, exemplo: v.coaching.melhorias[0]?.ponto ?? pior.o_que_faltou };
    t.vezes++;
    temas.set(pior.id, t);
  }

  const ganhas = list.filter((c) => c.desfecho === "ganho").length;
  const comDesfecho = list.filter((c) => c.desfecho === "ganho" || c.desfecho === "perdido").length;
  const perguntas = metrics.map((m) => (m.metrics as unknown as CallMetrics)?.perguntas.closer).filter((x): x is number => x != null);

  return {
    closer,
    calls: list,
    analisadas: analisadas.length,
    nota_media: avg(notas),
    abaixo_da_barra_pct: notas.length ? notas.filter((n) => n < barra).length / notas.length : null,
    fala_media: avg(list.map((c) => c.fala_closer).filter((x): x is number => x != null)),
    perguntas_media: avg(perguntas),
    conversao: { ganhas, com_desfecho: comDesfecho },
    criticas: list.filter((c) => c.analysis?.classificacao === "critica").length,
    cobertura: [...stageAgg].map(([id, s]) => ({ id, completo: s.completo, parcial: s.parcial, ausente: s.ausente, nota_media: avg(s.notas) ?? 0 })),
    temas_coaching: [...temas].map(([tema, t]) => ({ tema, ...t })).sort((a, b) => b.vezes - a.vezes).slice(0, 3),
  };
}

export type TeamSummary = {
  closers: Array<{
    id: string; nome: string; calls: number; analisadas: number; nota_media: number | null; abaixo_pct: number | null; criticas: number; fala_media: number | null;
    /** Calls com ganho / com ganho ou perda registrado (contexto: a nota ainda não prevê venda). */
    ganhas: number; com_desfecho: number;
    /** % das calls em que cada etapa ficou completa, da mais forte para a mais fraca. */
    etapas: Array<{ id: string; completo_pct: number }>;
  }>;
  etapas: Array<{ id: string; falha_pct: number; nota_media: number }>;
  churn: CallListItem[];
  criticas: CallListItem[];
  total: number;
  analisadas: number;
};

function etapasDoCloser(cs: CallListItem[]) {
  const m = new Map<string, { ok: number; n: number }>();
  for (const c of cs)
    for (const e of c.analysis?.etapas ?? []) {
      const s = m.get(e.id) ?? { ok: 0, n: 0 };
      s.n++;
      if (e.status === "completo") s.ok++;
      m.set(e.id, s);
    }
  return [...m].map(([id, s]) => ({ id, completo_pct: s.ok / s.n })).sort((a, b) => b.completo_pct - a.completo_pct);
}

/** Visão do gestor. `desde` limita churn e críticas ao período (ex.: semana). */
export async function teamSummary(db: Db, viewer: Viewer, playbook: string, barra: number, desde?: string): Promise<TeamSummary> {
  const list = await listCalls(db, viewer, { playbook });
  const ppl = await getPeople(db);
  const byCloser = new Map<string, CallListItem[]>();
  for (const c of list) if (c.closer_id) byCloser.set(c.closer_id, [...(byCloser.get(c.closer_id) ?? []), c]);
  const closers = [...byCloser].map(([id, cs]) => {
    const notas = cs.map((c) => c.analysis?.nota).filter((n): n is number => n != null);
    return {
      id,
      nome: ppl.find((p) => p.id === id)?.nome ?? id,
      calls: cs.length,
      analisadas: notas.length,
      nota_media: avg(notas),
      abaixo_pct: notas.length ? notas.filter((n) => n < barra).length / notas.length : null,
      criticas: cs.filter((c) => c.analysis?.classificacao === "critica").length,
      fala_media: avg(cs.map((c) => c.fala_closer).filter((x): x is number => x != null)),
      ganhas: cs.filter((c) => c.desfecho === "ganho").length,
      com_desfecho: cs.filter((c) => c.desfecho === "ganho" || c.desfecho === "perdido").length,
      etapas: etapasDoCloser(cs),
    };
  });
  const stage = new Map<string, { falhas: number; total: number; notas: number[] }>();
  for (const c of list)
    for (const e of c.analysis?.etapas ?? []) {
      const s = stage.get(e.id) ?? { falhas: 0, total: 0, notas: [] };
      s.total++;
      if (e.status !== "completo") s.falhas++;
      s.notas.push(e.nota ?? 0);
      stage.set(e.id, s);
    }
  const recent = (c: CallListItem) => !desde || (c.data ?? "") >= desde;
  return {
    closers: closers.sort((a, b) => (b.abaixo_pct ?? -1) - (a.abaixo_pct ?? -1) || (a.nota_media ?? 0) - (b.nota_media ?? 0)),
    etapas: [...stage].map(([id, s]) => ({ id, falha_pct: s.falhas / s.total, nota_media: avg(s.notas) ?? 0 })).sort((a, b) => b.falha_pct - a.falha_pct || a.nota_media - b.nota_media),
    churn: list.filter((c) => recent(c) && c.analysis && c.analysis.churn_vermelho > 0),
    criticas: list.filter((c) => recent(c) && c.analysis?.classificacao === "critica").sort((a, b) => (a.analysis!.nota ?? 0) - (b.analysis!.nota ?? 0)),
    total: list.length,
    analisadas: list.filter((c) => c.analysis).length,
  };
}

// ---- Notificações (central do painel): cada pessoa vê as próprias ----

export type NotificationItem = typeof notifications.$inferSelect & {
  payload: { titulo: string; resumo?: string; secoes: Array<{ titulo?: string; itens: string[] }>; links: Array<{ label: string; url: string }>; texto: string };
};

export async function listNotifications(db: Db, viewer: Viewer, f: { tipo?: string; naoLidas?: boolean } = {}): Promise<NotificationItem[]> {
  const rows = await db
    .select()
    .from(notifications)
    .where(
      and(
        eq(notifications.destinatario_id, viewer.id),
        eq(notifications.canal, "painel"),
        f.tipo ? eq(notifications.tipo, f.tipo) : undefined,
        f.naoLidas ? eq(notifications.lida, false) : undefined,
      ),
    )
    .orderBy(desc(notifications.created_at), desc(notifications.id));
  return rows as NotificationItem[];
}

export async function unreadNotifications(db: Db, viewer: Viewer): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)` })
    .from(notifications)
    .where(and(eq(notifications.destinatario_id, viewer.id), eq(notifications.canal, "painel"), eq(notifications.lida, false)))
    .get();
  return r?.n ?? 0;
}

// ---- Comparação entre closers ----

export type CloserComparison = {
  id: string;
  nome: string;
  calls: number;
  analisadas: number;
  nota_media: number | null;
  abaixo_pct: number | null;
  criticas: number;
  churn_vermelho_calls: number; // calls com churn vermelho confirmado (ou sem Jev)
  provisorias: number;
  fala_media: number | null;
  perguntas_media: number | null;
  conversao: { ganhas: number; com_desfecho: number };
  /** % das calls com a etapa completa e média de pontos (0–10) por etapa. */
  etapas: Record<string, { completo_pct: number; pontos_medios: number; n: number }>;
};

/** Os closers que o viewer pode ver, lado a lado, num playbook. */
export async function compareClosers(db: Db, viewer: Viewer, playbook: string, barra: number): Promise<CloserComparison[]> {
  const team = await teamSummary(db, viewer, playbook, barra);
  const out: CloserComparison[] = [];
  for (const c of team.closers) {
    const s = await closerSummary(db, viewer, c.id, playbook, barra);
    if (!s) continue;
    const etapas: CloserComparison["etapas"] = {};
    for (const e of s.cobertura) {
      const n = e.completo + e.parcial + e.ausente;
      etapas[e.id] = { completo_pct: n ? e.completo / n : 0, pontos_medios: e.nota_media, n };
    }
    out.push({
      id: c.id,
      nome: c.nome,
      calls: s.calls.length,
      analisadas: s.analisadas,
      nota_media: s.nota_media,
      abaixo_pct: s.abaixo_da_barra_pct,
      criticas: s.criticas,
      churn_vermelho_calls: s.calls.filter((x) => (x.analysis?.churn_vermelho ?? 0) > 0).length,
      provisorias: s.calls.filter((x) => x.analysis?.validacao === "provisoria").length,
      fala_media: s.fala_media,
      perguntas_media: s.perguntas_media,
      conversao: s.conversao,
      etapas,
    });
  }
  return out.sort((a, b) => (b.nota_media ?? -1) - (a.nota_media ?? -1));
}

// ---- Fila de calls adicionadas pelo painel ----

export type JobItem = { id: number; status: string; etapa: string | null; titulo: string | null; call_id: string | null; erro: string | null; created_at: string; updated_at: string; transcript_url: string | null };

/** Últimas calls adicionadas pelo painel (sem o texto colado, que pode ser grande). */
export async function listJobs(db: Db, limite = 6): Promise<JobItem[]> {
  return db
    .select({ id: jobs.id, status: jobs.status, etapa: jobs.etapa, titulo: jobs.titulo, call_id: jobs.call_id, erro: jobs.erro, created_at: jobs.created_at, updated_at: jobs.updated_at, transcript_url: jobs.transcript_url })
    .from(jobs)
    .orderBy(desc(jobs.id))
    .limit(limite);
}
