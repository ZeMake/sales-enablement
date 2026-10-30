/**
 * Confiabilidade de cada resultado da análise (etapas, riscos de churn, objeções) com o Jev como
 * segundo avaliador, independente do Opus: ele vê a transcrição, o critério do playbook e qual fala
 * está em jogo — nunca o veredito nem a justificativa do Opus (isso puxaria a concordância).
 *
 * Nível por resultado:
 *   alta       → Jev concorda com o Opus com probabilidade/confiança ≥ LIMIAR_ALTA
 *   media      → concorda com menos certeza
 *   divergente → Jev discorda: revisar
 * Isso mede acordo entre dois modelos, não acerto. Quem diz se "alta" acerta mais é a calibração humana.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { parse } from "yaml";
import type { Db } from "../db/client";
import { analyses, reliability } from "../db/schema";
import { logCost } from "../llm/client";
import { decide, estimateTokens, JEV_STATE_BUDGET_TOKENS, JEV_USD_PER_INPUT_TOKEN, jevMaskPii, jevModel, type Answer, type ChoiceAnswer, type FetchLike, type NoulAnswer, type Question } from "../llm/jev";
import { maskPii } from "../pii";
import { requiresLeadEvidence, type Playbook } from "../playbook";
import type { Segment } from "../types";
import { loadSegments } from "./run";
import { recompute } from "./score";
import type { Config } from "../config";
import type { VerifiedAnalysis } from "./schema";

export const LIMIAR_ALTA = 0.8;
const JANELA = 8; // falas em volta de cada citação quando a call inteira não cabe no contexto

export type Nivel = "alta" | "media" | "divergente";
export type Kind = "etapa" | "churn" | "objecao_existe" | "objecao_resolvida";

export type ReliabilityItem = {
  kind: Kind;
  ref: string; // id da etapa ou índice do risco/objeção
  pergunta: string; // chave da pergunta enviada
  opus: string; // veredito do Opus (completo/parcial/ausente, sim/nao)
  jev: string; // veredito do Jev
  prob: number; // confiança do Jev no próprio veredito (0..1)
  probabilidades?: Record<string, number>;
  nivel: Nivel;
};

// ---- estado (transcrição) ----

export function renderState(segs: Segment[], keep?: Set<number>): string {
  const mask = jevMaskPii();
  return segs
    .filter((s) => !s.flags?.length && (!keep || keep.has(s.idx)))
    .map((s) => `[${s.idx}] (${s.role}) ${s.speaker}: ${mask ? maskPii(s.text) : s.text}`)
    .join("\n");
}

/** A call inteira se couber; senão, janelas em volta das falas citadas (e o resultado avisa). */
export function buildState(segs: Segment[], idxs: number[]): { state: string; contexto: "completo" | "trechos" } {
  const full = renderState(segs);
  if (estimateTokens(full) <= JEV_STATE_BUDGET_TOKENS) return { state: full, contexto: "completo" };
  const keep = new Set<number>();
  for (const i of idxs) for (let j = i - JANELA; j <= i + JANELA; j++) keep.add(j);
  return { state: renderState(segs, keep), contexto: "trechos" };
}

// ---- perguntas ----

type Produtos = { promessas_proibidas?: string[]; politica_comercial?: { garantias_permitidas?: string } };

export function loadRules(root = process.cwd()): { proibidas: string[]; permitidas: string } {
  const p = parse(fs.readFileSync(path.join(root, "config/products.yaml"), "utf8")) as Produtos;
  return { proibidas: p.promessas_proibidas ?? [], permitidas: p.politica_comercial?.garantias_permitidas ?? "" };
}

const SEVERIDADE: Record<string, string> = {
  vermelho: "viola explicitamente uma promessa proibida",
  amarelo: "cria expectativa exagerada ou ambígua que o atendimento vai ter que corrigir depois",
};

export function buildQuestions(a: VerifiedAnalysis, playbook: Playbook, rules = loadRules()): Record<string, Question> {
  const q: Record<string, Question> = {};
  for (const pe of playbook.etapas) {
    const lead = requiresLeadEvidence(playbook, pe)
      ? " Só conta o que o LEAD disse: afirmação do closer que o lead apenas confirmou com 'sim' não completa a etapa."
      : "";
    q[`etapa__${pe.id}`] = {
      type: "choice",
      instructions: `Avalie a etapa "${pe.nome}" do playbook comercial nesta call. Objetivo da etapa: ${pe.objetivo.trim()}${lead} Falas marcadas (cliente) são do lead; (closer) é quem vende.`,
      criteria: {
        completo: pe.completo_quando.trim(),
        parcial: pe.parcial_quando.trim(),
        ausente: "A etapa não aconteceu na call (nada do que caracteriza a etapa foi dito).",
      },
    };
  }
  a.risco_churn.forEach((r, i) => {
    q[`churn__${i}`] = {
      type: "noul",
      instructions: `Na fala [${r.segment_idx}], alguém da Make disse: "${r.citacao}". Considerando a conversa em volta, essa fala é um risco de churn (promessa que pode virar frustração e cancelamento depois)? Promessas proibidas: ${rules.proibidas.join("; ")}.`,
      criteria: {
        true: `Sim: a fala ${SEVERIDADE[r.severidade] ?? SEVERIDADE.amarelo}.`,
        false: `Não: é descrição correta do produto, argumento permitido (${rules.permitidas}) ou fala sem promessa.`,
      },
    };
  });
  a.objecoes.forEach((o, i) => {
    q[`objecao__${i}__existe`] = {
      type: "noul",
      instructions: `Na fala [${o.segment_idx}], o lead disse: "${o.citacao}". Isso é uma objeção do lead à compra (tipo: ${o.tipo})?`,
      criteria: { true: "Sim: o lead levantou uma resistência, dúvida ou obstáculo à compra.", false: "Não: é comentário, pergunta neutra ou informação sem resistência." },
    };
    q[`objecao__${i}__resolvida`] = {
      type: "noul",
      instructions: `Ainda sobre a objeção da fala [${o.segment_idx}] ("${o.citacao}"): ela ficou resolvida dentro da call?`,
      criteria: {
        true: "Sim: o closer respondeu e o lead aceitou a resposta ou avançou sem voltar ao assunto.",
        false: "Não: a objeção ficou em aberto, foi adiada ou o lead manteve a resistência.",
      },
    };
  });
  return q;
}

// ---- interpretação ----

export function nivel(concorda: boolean, prob: number): Nivel {
  if (!concorda) return "divergente";
  return prob >= LIMIAR_ALTA ? "alta" : "media";
}

/** Noul: o veredito do Jev é sim se p ≥ 0,5; a confiança é a probabilidade do lado escolhido. */
function fromNoul(ans: NoulAnswer, opusSim: boolean) {
  const sim = ans.noul >= 0.5;
  const prob = sim ? ans.noul : 1 - ans.noul;
  return { jev: sim ? "sim" : "nao", prob, nivel: nivel(sim === opusSim, prob) };
}

export function interpret(a: VerifiedAnalysis, answers: Record<string, Answer>): ReliabilityItem[] {
  const out: ReliabilityItem[] = [];
  for (const [chave, ans] of Object.entries(answers)) {
    const [kind, ref, sub] = chave.split("__");
    if (kind === "etapa" && ans.type === "choice") {
      const e = a.etapas.find((x) => x.id === ref);
      if (!e) continue;
      const c = ans as ChoiceAnswer;
      const prob = c.probabilities?.[c.choice] ?? c.confidence;
      out.push({ kind: "etapa", ref, pergunta: chave, opus: e.status, jev: c.choice, prob, probabilidades: c.probabilities, nivel: nivel(c.choice === e.status, prob) });
    } else if (kind === "churn" && ans.type === "noul") {
      if (!a.risco_churn[Number(ref)]) continue;
      out.push({ kind: "churn", ref, pergunta: chave, opus: "sim", ...fromNoul(ans, true) });
    } else if (kind === "objecao" && ans.type === "noul") {
      const o = a.objecoes[Number(ref)];
      if (!o) continue;
      if (sub === "existe") out.push({ kind: "objecao_existe", ref, pergunta: chave, opus: "sim", ...fromNoul(ans, true) });
      else out.push({ kind: "objecao_resolvida", ref, pergunta: chave, opus: o.resolvida ? "sim" : "nao", ...fromNoul(ans, o.resolvida) });
    }
  }
  return out;
}

/** Resumo por tipo: quantos resultados em cada nível. */
export function summarize(items: ReliabilityItem[]) {
  const by = new Map<Kind, Record<Nivel, number>>();
  for (const it of items) {
    const r = by.get(it.kind) ?? { alta: 0, media: 0, divergente: 0 };
    r[it.nivel]++;
    by.set(it.kind, r);
  }
  return [...by].map(([kind, n]) => ({ kind, ...n, total: n.alta + n.media + n.divergente }));
}

// ---- execução ----

function prepare(a: VerifiedAnalysis, segs: Segment[], playbook: Playbook) {
  const idxs = [...a.etapas.flatMap((e) => e.evidencias.map((ev) => ev.segment_idx)), ...a.risco_churn.map((r) => r.segment_idx), ...a.objecoes.map((o) => o.segment_idx)];
  const { state, contexto } = buildState(segs, idxs.filter((i): i is number => i != null));
  return { state, contexto, questions: buildQuestions(a, playbook) };
}

async function load(db: Db, analysisId: string) {
  const row = await db.select().from(analyses).where(eq(analyses.id, analysisId)).get();
  if (!row?.result) throw new Error(`Análise ${analysisId} não encontrada`);
  return { row, a: row.result as unknown as VerifiedAnalysis, segs: await loadSegments(db, row.call_id) };
}

/** Estimativa sem chamar a API: tokens de entrada (state + perguntas) × preço do Jev. */
export async function estimateReliability(db: Db, analysisId: string, playbook: Playbook) {
  const { a, segs } = await load(db, analysisId);
  const p = prepare(a, segs, playbook);
  const tokens = estimateTokens(p.state + JSON.stringify(p.questions));
  return { tokens, usd: tokens * JEV_USD_PER_INPUT_TOKEN, perguntas: Object.keys(p.questions).length, contexto: p.contexto };
}

export async function runReliability(db: Db, analysisId: string, playbook: Playbook, opts: { fetch?: FetchLike; cfg?: Config } = {}) {
  const { row, a, segs } = await load(db, analysisId);
  const p = prepare(a, segs, playbook);
  const res = await decide({ state: p.state, questions: p.questions }, { fetch: opts.fetch });
  const items = interpret(a, res.answers);
  await db.transaction(async (tx) => {
    await tx.delete(reliability).where(eq(reliability.analysis_id, analysisId));
    if (items.length)
      await tx.insert(reliability).values(items.map((it) => ({
        analysis_id: analysisId, kind: it.kind, ref: it.ref, opus: it.opus, jev: it.jev, prob: it.prob,
        probabilidades: it.probabilidades, nivel: it.nivel, model: res.model ?? jevModel(), contexto: p.contexto,
      })));
  });
  const { usd } = await logCost(db, {
    call_id: row.call_id, etapa: `confiabilidade:${playbook.id}`, model: res.model ?? jevModel(), billing: "api",
    usage: { input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens }, usd: res.usage.cost ?? 0,
  });
  // Com o segundo julgamento gravado, nota/selo/classificação mudam: recalcula (sem IA).
  const final = opts.cfg ? await recompute(db, opts.cfg, analysisId, playbook) : undefined;
  return { items, usd, final, contexto: p.contexto, perguntas: Object.keys(p.questions).length, respondidas: Object.keys(res.answers).length };
}
