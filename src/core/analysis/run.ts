import fs from "node:fs";
import path from "node:path";
import { and, asc, eq } from "drizzle-orm";
import { parse } from "yaml";
import type { Config } from "../config";
import type { Db } from "../db/client";
import { analyses, calls, churn_flags, evidences, next_steps, objections, segments as segmentsTable, stage_results } from "../db/schema";
import { analysisModel, logCost } from "../llm/client";
import { costUsd, usdBrl } from "../llm/pricing";
import { getProvider } from "../llm/provider";
import { maskPii, shouldMaskPii } from "../pii";
import { renderPlaybook, type Playbook } from "../playbook";
import type { CallMetrics, Segment } from "../types";
import { classify, type Classificacao } from "./classify";
import { recompute } from "./score";
import { AnalysisOutput, type VerifiedAnalysis } from "./schema";
import { verifyAnalysis } from "./verify";

export const ANALYSIS_PROMPT_VERSION = "analysis.v2";
export const ANALYSIS_EFFORT = "high" as const;

type Produtos = { produtos: Array<{ nome: string; entrega: string[]; prazos_reais: string[]; nao_entrega: string[] }>; promessas_proibidas: string[]; politica_comercial: Record<string, unknown> };

export function productsIncomplete(root = process.cwd()): boolean {
  const p = parse(fs.readFileSync(path.join(root, "config/products.yaml"), "utf8")) as Produtos;
  return p.produtos.every((x) => !x.entrega.length && !x.nao_entrega.length) && !p.promessas_proibidas?.length;
}

function renderProducts(root: string): string {
  const raw = fs.readFileSync(path.join(root, "config/products.yaml"), "utf8");
  if (!productsIncomplete(root)) return raw;
  return [
    "A base de produtos AINDA NÃO FOI PREENCHIDA (não sabemos o que cada produto entrega ou não entrega, nem a política comercial).",
    "Por isso: use só os riscos genéricos (garantia de resultado, prazo de resultado, 'não vai precisar fazer nada', expectativa claramente exagerada).",
    "Não marque `funcionalidade_inexistente` nem `condicao_fora_da_politica` com severidade vermelha — no máximo amarelo, explicando que depende de confirmação.",
    "Produtos: Make ADS, MakeCRM, Mavi, MakeSDR, Kit de Autoridade Digital, Social Leads, Motor de Vendas (ex-Acelerador de Lucros), ALL MAKE.",
  ].join("\n");
}

/** Bloco fixo por playbook — idêntico entre calls para aproveitar o cache de prompt. */
export function buildSystemPrompt(playbook: Playbook, root = process.cwd()): string {
  const tpl = fs.readFileSync(path.join(root, "prompts", `${ANALYSIS_PROMPT_VERSION}.md`), "utf8");
  return tpl.replace("{{PRODUTOS}}", renderProducts(root)).replace("{{PLAYBOOK}}", renderPlaybook(playbook));
}

export function renderTranscript(segs: Segment[]): string {
  const mask = shouldMaskPii();
  return segs
    .map((s) => {
      if (s.flags?.includes("ruido")) return `[${s.idx}] [ruído] ${s.speaker}: (trecho omitido)`;
      const tag = s.flags?.includes("bastidor") ? `(bastidor) ` : "";
      return `[${s.idx}] ${tag}(${s.role}) ${s.speaker}: ${mask ? maskPii(s.text) : s.text}`;
    })
    .join("\n");
}

type CallRow = typeof calls.$inferSelect;

export function buildUserPrompt(call: CallRow, segs: Segment[], playbookId: string): string {
  const meta = [
    `call_id: ${call.id}`,
    call.data_hora && `data: ${call.data_hora}`,
    call.produto && `produto: ${call.produto}`,
    call.tipo_call && `tipo de call: ${call.tipo_call}`,
    call.closer_speaker && `closer: ${call.closer_speaker}`,
    `duração: ${Math.round((call.duration_sec ?? 0) / 60)} min${call.tempo_estimado ? " (sem timestamps)" : ""}`,
  ].filter(Boolean);
  return `Avalie esta call no playbook "${playbookId}".\n\n${meta.join("\n")}\n\n<transcricao>\n${renderTranscript(segs)}\n</transcricao>`;
}

export async function loadSegments(db: Db, callId: string): Promise<Segment[]> {
  const rows = await db.select().from(segmentsTable).where(eq(segmentsTable.call_id, callId)).orderBy(asc(segmentsTable.idx));
  return rows.map((r) => ({
    idx: r.idx, speaker: r.speaker, role: r.role as Segment["role"], start: r.start ?? undefined, end: r.end ?? undefined,
    text: r.text, flags: (r.flags ?? undefined) as Segment["flags"],
  }));
}

export const analysisId = (callId: string, playbookId: string, promptVersion = ANALYSIS_PROMPT_VERSION) =>
  `${callId}__${playbookId}__${promptVersion}`;

/** Estimativa antes de rodar: ≈3,5 caracteres/token em PT-BR; saída + raciocínio ≈ 16k tokens (medido: ~15k). */
export function estimateAnalysis(system: string, user: string, model: string) {
  const input = Math.ceil((system.length + user.length) / 3.5);
  const output = 16_000;
  return { input, output, usd: costUsd(model, { input_tokens: input, output_tokens: output }) };
}

export type AnalyzeResult = {
  call_id: string;
  playbook_id: string;
  analysis_id: string;
  nota: number;
  nota_llm: number;
  classificacao: Classificacao;
  motivos: string[];
  etapas: Array<{ id: string; status: string }>;
  citacoes_total: number;
  citacoes_descartadas: number;
  churn: number;
  usd: number;
  billing: string;
  duracao_ms: number;
};

export async function analyzeCall(db: Db, cfg: Config, callId: string, playbook: Playbook): Promise<AnalyzeResult> {
  const call = await db.select().from(calls).where(eq(calls.id, callId)).get();
  if (!call) throw new Error(`Call ${callId} não encontrada. Rode pnpm ingest.`);
  if (call.triage_status !== "comercial") throw new Error(`Call ${callId} é ${call.triage_status}: não recebe nota.`);
  const segs = await loadSegments(db, callId);
  const model = analysisModel();
  const provider = getProvider();

  const t0 = Date.now();
  const res = await provider
    .complete({
      model,
      system: buildSystemPrompt(playbook),
      user: buildUserPrompt(call, segs, playbook.id),
      schema: AnalysisOutput,
      effort: ANALYSIS_EFFORT,
      maxTokens: 64000,
    })
    .catch(async (e: Error & { custoUsd?: number; usage?: { input_tokens: number; output_tokens: number } }) => {
      // Tentativa que falhou também custou: registra antes de propagar o erro.
      if (e.custoUsd) await logCost(db, { call_id: callId, etapa: `analise_falhou:${playbook.id}`, model, usage: e.usage ?? { input_tokens: 0, output_tokens: 0 }, usd: e.custoUsd, billing: "api" });
      throw e;
    });
  const duracao_ms = Date.now() - t0;

  const verified = verifyAnalysis(res.data, segs, playbook);
  if (productsIncomplete()) verified.observacoes = `${verified.observacoes} [sistema] Base de produtos incompleta: risco de funcionalidade inexistente/condição fora da política não é avaliado com precisão.`.trim();
  const metrics = call.metrics as unknown as CallMetrics;
  const talk = metrics.fala_pct.closer;
  const { classificacao, motivos } = classify(verified, { talkRatioCloser: talk, tempoEstimado: call.tempo_estimado }, cfg.rules.classificacao);

  const { usd, brl } = await logCost(db, { call_id: callId, etapa: `analise:${playbook.id}`, model, usage: res.usage, usd: res.costUsd, billing: res.billing });
  const id = analysisId(callId, playbook.id);
  await persist(db, { id, callId, playbook, model, provider: provider.name, billing: res.billing, verified, classificacao, motivos, talk, usage: res.usage, usd, brl, duracao_ms });
  // Nota pelo status + faixa/selo + churn confirmado (usa o Jev e a revisão humana se já existirem).
  const final = await recompute(db, cfg, id, playbook);

  return {
    call_id: callId,
    playbook_id: playbook.id,
    analysis_id: id,
    nota: final.nota,
    nota_llm: verified.verificacao.nota_llm,
    classificacao: final.classificacao,
    motivos: final.motivos,
    etapas: verified.etapas.map((e) => ({ id: e.id, status: e.status })),
    citacoes_total: verified.verificacao.citacoes_total,
    citacoes_descartadas: verified.verificacao.citacoes_descartadas,
    churn: verified.risco_churn.length,
    usd,
    billing: res.billing,
    duracao_ms,
  };
}

async function persist(
  db: Db,
  p: {
    id: string; callId: string; playbook: Playbook; model: string; provider: string; billing: string;
    verified: VerifiedAnalysis; classificacao: Classificacao; motivos: string[]; talk: number;
    usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null };
    usd: number; brl: number; duracao_ms: number;
  },
) {
  const v = p.verified;
  const rebaixadas = new Set(v.verificacao.etapas_rebaixadas.map((r) => r.id));
  await db.transaction(async (tx) => {
    await tx.delete(analyses).where(eq(analyses.id, p.id)); // cascata limpa etapas, evidências etc.
    await tx.insert(analyses).values({
      id: p.id,
      call_id: p.callId,
      playbook_id: p.playbook.id,
      playbook_version: p.playbook.versao,
      prompt_version: ANALYSIS_PROMPT_VERSION,
      model: p.model,
      provider: p.provider,
      billing: p.billing,
      nota_aderencia: v.nota_aderencia_0a100,
      nota_llm: v.verificacao.nota_llm,
      talk_ratio_closer: p.talk,
      classificacao: p.classificacao,
      motivos: p.motivos,
      confianca: v.confianca,
      result: v as unknown as Record<string, unknown>,
      citacoes_total: v.verificacao.citacoes_total,
      citacoes_descartadas: v.verificacao.citacoes_descartadas,
      duracao_ms: p.duracao_ms,
      tokens_input: p.usage.input_tokens,
      tokens_output: p.usage.output_tokens,
      tokens_cache_read: p.usage.cache_read_input_tokens ?? 0,
      tokens_cache_write: p.usage.cache_creation_input_tokens ?? 0,
      custo_usd: p.usd,
      custo_brl: p.brl,
    });
    for (const e of v.etapas) {
      await tx.insert(stage_results).values({
        analysis_id: p.id, stage_id: e.id, status: e.status, nota: e.nota_0a10,
        o_que_faltou: e.o_que_faltou, pergunta_sugerida: e.pergunta_sugerida, rebaixada: rebaixadas.has(e.id),
      });
    }
    const evRows = [
      ...v.etapas.flatMap((e) => e.evidencias.map((ev) => ({ kind: "etapa", ref_id: e.id, ...ev, valida: true }))),
      ...v.verificacao.descartes.map((d) => ({ kind: d.onde.split(":")[0], ref_id: d.onde.split(":")[1] ?? null, citacao: d.citacao, segment_idx: d.segment_idx ?? null, valida: false })),
    ];
    if (evRows.length) await tx.insert(evidences).values(evRows.map((r) => ({ analysis_id: p.id, ...r })));
    if (v.objecoes.length) await tx.insert(objections).values(v.objecoes.map((o) => ({ analysis_id: p.id, ...o })));
    if (v.risco_churn.length) await tx.insert(churn_flags).values(v.risco_churn.map((r) => ({ analysis_id: p.id, ...r })));
    // Próximos passos: um conjunto por call (vem da análise mais recente), status editável no painel.
    await tx.delete(next_steps).where(and(eq(next_steps.call_id, p.callId)));
    if (v.proximos_passos.length)
      await tx.insert(next_steps).values(v.proximos_passos.map((n) => ({ call_id: p.callId, analysis_id: p.id, ...n })));
  });
}

export { usdBrl };
