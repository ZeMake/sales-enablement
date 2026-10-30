/**
 * Fila de calls adicionadas pelo painel. Uma por vez (a análise pela assinatura do Claude não roda em
 * paralelo): lê a transcrição (link ou texto colado), ingere com triagem, analisa em cada playbook
 * ativo, gera alertas, pede a segunda opinião (Jev, se houver chave) e recalcula a nota.
 */
import { and, asc, eq, isNull, lt, or } from "drizzle-orm";
import { analysisId, analyzeCall } from "./analysis/run";
import { runReliability } from "./analysis/reliability";
import type { Config } from "./config";
import type { Db } from "./db/client";
import { analyses, calls, jobs, reliability } from "./db/schema";
import { ingestCall } from "./ingest";
import { jevAvailable } from "./llm/jev";
import { alertAnalysis } from "./notify/alerts";
import { isActive, loadPlaybooks } from "./playbook";
import type { ManifestRow } from "./sources/manifest";
import { UrlSource } from "./sources/url";

export type Job = typeof jobs.$inferSelect;

export type NovoJob = { transcriptUrl?: string; transcriptText?: string; videoUrl?: string; closer?: string; desfecho?: string; titulo?: string; callId?: string; playbook?: string };

export async function enqueue(db: Db, j: NovoJob): Promise<number> {
  const [row] = await db
    .insert(jobs)
    .values({
      status: "na_fila",
      etapa: "na fila",
      transcript_url: j.transcriptUrl || null,
      transcript_text: j.transcriptText || null,
      video_url: j.videoUrl || null,
      closer: j.closer || null,
      desfecho: j.desfecho || null,
      titulo: j.titulo || null,
      call_id: j.callId || null,
      playbook: j.playbook || null,
    })
    .returning({ id: jobs.id });
  return row.id;
}

const agora = () => new Date().toISOString();

async function etapa(db: Db, id: number, texto: string, extra: Partial<Job> = {}) {
  await db.update(jobs).set({ etapa: texto, updated_at: agora(), ...extra }).where(eq(jobs.id, id));
}

/**
 * Faz UM passo da call (o próximo que falta) e diz se ainda há trabalho. O passo é deduzido do banco:
 * ingerir → analisar cada playbook (+ alertas) → segunda opinião de cada um → pronta. Idempotente:
 * se uma chamada cair no meio, a próxima retoma de onde parou. Cada passo cabe nos 300 s da Vercel.
 */
export async function processStep(db: Db, cfg: Config, job: Job): Promise<{ continua: boolean }> {
  const custo = (n: number) => (job.custo_usd ?? 0) + n;
  try {
    // 1. Ingestão (leitura do link ou do texto colado + triagem)
    const existente = job.call_id ? await db.select().from(calls).where(eq(calls.id, job.call_id)).get() : undefined;
    if (!existente) {
      await etapa(db, job.id, "lendo a transcrição e fazendo a triagem", { status: "rodando" });
      const meta: Partial<ManifestRow> = {
        ...(job.closer ? { closer: job.closer } : {}),
        ...(job.desfecho ? { desfecho: job.desfecho as ManifestRow["desfecho"] } : {}),
        ...(job.titulo ? { obs: job.titulo } : {}),
      };
      const src = new UrlSource(
        [{ transcriptUrl: job.transcript_url ?? undefined, transcriptText: job.transcript_text ?? undefined, videoUrl: job.video_url ?? undefined, meta: Object.keys(meta).length ? meta : undefined }],
        cfg.team,
      );
      const sc = (await src.list()).calls[0];
      const r = await ingestCall(db, cfg, src, sc, {});
      const call = await db.select().from(calls).where(eq(calls.id, sc.call_id)).get();
      if (!call) throw new Error(r.motivo ?? "não foi possível ingerir a call");
      await etapa(db, job.id, "triagem feita", { call_id: call.id, titulo: job.titulo ?? sc.meta.obs ?? null, custo_usd: custo(r.custoUsd ?? 0) });
      return { continua: true };
    }
    if (existente.triage_status !== "comercial") {
      await etapa(db, job.id, `não comercial: ${existente.triage_motivo ?? "sem nota"}`, { status: "concluida" });
      return { continua: false };
    }

    const playbooks = loadPlaybooks().filter((p) => isActive(p) && (!job.playbook || p.id === job.playbook));
    // 2. Uma análise por passo
    for (const pb of playbooks) {
      const ja = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.id, analysisId(existente.id, pb.id))).get();
      if (ja) continue;
      await etapa(db, job.id, `analisando · ${pb.nome}`, { status: "rodando" });
      const a = await analyzeCall(db, cfg, existente.id, pb);
      await alertAnalysis(db, cfg, a.analysis_id);
      await etapa(db, job.id, `${pb.nome} analisado`, { custo_usd: custo(a.usd) });
      return { continua: true };
    }
    // 3. Segunda opinião, uma por passo
    if (jevAvailable())
      for (const pb of playbooks) {
        const id = analysisId(existente.id, pb.id);
        const temRel = await db.select({ id: reliability.id }).from(reliability).where(eq(reliability.analysis_id, id)).get();
        if (temRel) continue;
        await etapa(db, job.id, `segunda opinião · ${pb.nome}`, { status: "rodando" });
        const rel = await runReliability(db, id, pb, { cfg });
        await etapa(db, job.id, `segunda opinião · ${pb.nome} feita`, { custo_usd: custo(rel.usd) });
        return { continua: true };
      }
    await etapa(db, job.id, "pronta", { status: "concluida" });
    return { continua: false };
  } catch (e) {
    await etapa(db, job.id, "erro", { status: "erro", erro: (e as Error).message.slice(0, 500) });
    return { continua: false };
  }
}

/** Processa uma call inteira (no PC: passos em sequência). */
export async function processJob(db: Db, cfg: Config, job: Job): Promise<void> {
  for (;;) {
    const atual = await db.select().from(jobs).where(eq(jobs.id, job.id)).get();
    if (!atual) return;
    const { continua } = await processStep(db, cfg, atual);
    if (!continua) return;
  }
}

/** Próximo job a trabalhar: o que já está rodando (retomar) ou o mais antigo na fila. */
export async function proximoJob(db: Db): Promise<Job | undefined> {
  return (
    (await db.select().from(jobs).where(eq(jobs.status, "rodando")).orderBy(asc(jobs.id)).get()) ??
    (await db.select().from(jobs).where(eq(jobs.status, "na_fila")).orderBy(asc(jobs.id)).get())
  );
}

/** Quantas calls foram adicionadas hoje (horário de Brasília): base do limite diário. */
export async function adicionadasHoje(db: Db): Promise<number> {
  const hoje = new Date().toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" });
  const todas = await db.select({ c: jobs.created_at }).from(jobs);
  return todas.filter((j) => new Date(j.c).toLocaleDateString("sv-SE", { timeZone: "America/Sao_Paulo" }) === hoje).length;
}

/** Processa a fila até esvaziar (no PC). Devolve quantas calls rodou. */
export async function runQueue(db: Db, cfg: Config): Promise<number> {
  let n = 0;
  for (;;) {
    const job = await proximoJob(db);
    if (!job) return n;
    await processJob(db, cfg, job);
    n++;
  }
}

/**
 * Trava o job para UM passo (até 290 s). Devolve false se outro já está trabalhando nele.
 * É a garantia de que duas chamadas simultâneas não analisam a mesma call duas vezes.
 */
export async function travar(db: Db, id: number, ms = 290_000): Promise<boolean> {
  const agoraMs = Date.now();
  const r = await db
    .update(jobs)
    .set({ trava_ate: agoraMs + ms })
    .where(and(eq(jobs.id, id), or(isNull(jobs.trava_ate), lt(jobs.trava_ate, agoraMs))))
    .returning({ id: jobs.id });
  return r.length > 0;
}

export async function destravar(db: Db, id: number) {
  await db.update(jobs).set({ trava_ate: null }).where(eq(jobs.id, id));
}

/** Já existe uma fila rodando? (Alguém com status "rodando" atualizado nos últimos 20 min.) */
/** Job em andamento (na fila, rodando ou com erro) de uma call: para não enfileirar duas vezes. */
export async function jobsDaCall(db: Db, callId: string): Promise<Job[]> {
  const r = await db.select().from(jobs).where(eq(jobs.call_id, callId));
  return r.filter((j) => j.status !== "concluida");
}

export async function filaAtiva(db: Db): Promise<boolean> {
  const rodando = await db.select({ u: jobs.updated_at }).from(jobs).where(eq(jobs.status, "rodando"));
  return rodando.some((r) => Date.now() - new Date(r.u).getTime() < 20 * 60_000);
}
