/**
 * Calibração (SPEC §13): o humano avalia 10–15 calls num CSV (status por etapa + churn sim/não) e
 * comparamos com a IA. Mais o teste de estabilidade: reanalisar a mesma call e medir a variação.
 *
 * O template NÃO traz a resposta da IA, de propósito: ver a resposta antes ancora o avaliador e
 * infla a concordância.
 */
import { and, eq, inArray } from "drizzle-orm";
import { analysisModel, logCost } from "./llm/client";
import { getProvider } from "./llm/provider";
import { ANALYSIS_EFFORT, ANALYSIS_PROMPT_VERSION, buildSystemPrompt, buildUserPrompt, estimateAnalysis, loadSegments } from "./analysis/run";
import { AnalysisOutput, type VerifiedAnalysis } from "./analysis/schema";
import { verifyAnalysis } from "./analysis/verify";
import type { Db } from "./db/client";
import { analyses, calibration_labels, calls, reliability, stability_runs } from "./db/schema";
import type { Playbook } from "./playbook";
import { leadName } from "./queries";

export const STATUS = ["completo", "parcial", "ausente"] as const;
export type Status = (typeof STATUS)[number];
export const CHURN_ROW = "risco_de_churn";
const HEADER = ["prioridade", "call_id", "lead", "playbook", "etapa", "etapa_nome", "avaliacao", "avaliador", "obs"];

// ---- CSV (vírgula ou ponto e vírgula, aspas, BOM do Excel) ----

export function parseCsv(text: string): Record<string, string>[] {
  const src = text.replace(/^﻿/, "");
  const firstLine = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
    } else cell += ch;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return [];
  const keys = head.map((h) => h.trim().toLowerCase());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

const csvCell = (s: string) => (/[",;\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
export const toCsv = (rows: string[][]) => "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n";

// ---- template ----

/**
 * Uma linha por call × playbook × etapa, mais uma linha de churn (sim/nao). Sem a resposta de
 * nenhum modelo. Começa pelo que o Opus e o Jev discordam ("revisar primeiro"): é onde a sua
 * avaliação decide a nota. Dizer ONDE há divergência não revela QUAL é a resposta de cada um.
 */
export async function calibrationTemplate(db: Db, playbooks: Playbook[]): Promise<string> {
  const an = await db.select({ id: analyses.id, call_id: analyses.call_id, playbook_id: analyses.playbook_id }).from(analyses);
  const callIds = [...new Set(an.map((a) => a.call_id))];
  const cs = callIds.length ? await db.select().from(calls).where(inArray(calls.id, callIds)) : [];
  const div = await db.select({ analysis_id: reliability.analysis_id, kind: reliability.kind, ref: reliability.ref }).from(reliability).where(eq(reliability.nivel, "divergente"));
  type Bloco = { prioridade: number; linhas: string[][] };
  const blocos: Bloco[] = [];
  for (const c of cs)
    for (const pb of playbooks) {
      const a = an.find((x) => x.call_id === c.id && x.playbook_id === pb.id);
      if (!a) continue;
      const d = div.filter((x) => x.analysis_id === a.id);
      const etapaDiv = new Set(d.filter((x) => x.kind === "etapa").map((x) => x.ref));
      const churnDiv = d.some((x) => x.kind === "churn");
      const linha = (p: boolean, etapa: string, nome: string) => [p ? "revisar primeiro" : "", c.id, leadName(c), pb.id, etapa, nome, "", "", ""];
      const etapas = [...pb.etapas].sort((x, y) => Number(etapaDiv.has(y.id)) - Number(etapaDiv.has(x.id)));
      blocos.push({
        prioridade: etapaDiv.size + (churnDiv ? 1 : 0),
        linhas: [...etapas.map((e) => linha(etapaDiv.has(e.id), e.id, e.nome)), linha(churnDiv, CHURN_ROW, "Risco de churn (alguma promessa/expectativa perigosa?)")],
      });
    }
  blocos.sort((x, y) => y.prioridade - x.prioridade || x.linhas[0][1].localeCompare(y.linhas[0][1]));
  return toCsv([HEADER, ...blocos.flatMap((b) => b.linhas)]);
}

// ---- importação ----

export type Label = { call_id: string; playbook_id: string; stage_id: string; status: string; churn: boolean | null; avaliador: string };

const norm = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();

/** Valida as linhas preenchidas. Linhas com avaliação vazia são ignoradas (avaliação parcial vale). */
export function parseLabels(rows: Record<string, string>[], avaliadorPadrao = "victor"): { labels: Label[]; erros: string[] } {
  const labels: Label[] = [];
  const erros: string[] = [];
  rows.forEach((r, i) => {
    const v = norm(r.avaliacao ?? "");
    if (!v) return;
    const linha = `linha ${i + 2} (${r.call_id} · ${r.etapa})`;
    if (!r.call_id || !r.playbook || !r.etapa) return void erros.push(`${linha}: faltam call_id, playbook ou etapa`);
    const base = { call_id: r.call_id, playbook_id: r.playbook, stage_id: r.etapa, avaliador: r.avaliador || avaliadorPadrao };
    if (r.etapa === CHURN_ROW) {
      if (!["sim", "nao", "s", "n"].includes(v)) return void erros.push(`${linha}: churn deve ser sim ou nao (veio "${r.avaliacao}")`);
      labels.push({ ...base, status: v.startsWith("s") ? "sim" : "nao", churn: v.startsWith("s") });
    } else {
      if (!(STATUS as readonly string[]).includes(v)) return void erros.push(`${linha}: status deve ser completo, parcial ou ausente (veio "${r.avaliacao}")`);
      labels.push({ ...base, status: v, churn: null });
    }
  });
  return { labels, erros };
}

/** Substitui as avaliações daquele avaliador para cada call × playbook importado. call_id inexistente é ignorado e devolvido. */
export async function saveLabels(db: Db, all: Label[]): Promise<{ salvas: number; desconhecidas: string[] }> {
  const ids = [...new Set(all.map((l) => l.call_id))];
  const existentes = new Set(ids.length ? (await db.select({ id: calls.id }).from(calls).where(inArray(calls.id, ids))).map((c) => c.id) : []);
  const labels = all.filter((l) => existentes.has(l.call_id));
  const keys = new Set(labels.map((l) => `${l.call_id}|${l.playbook_id}|${l.avaliador}`));
  await db.transaction(async (tx) => {
    for (const k of keys) {
      const [call_id, playbook_id, avaliador] = k.split("|");
      await tx.delete(calibration_labels).where(and(eq(calibration_labels.call_id, call_id), eq(calibration_labels.playbook_id, playbook_id), eq(calibration_labels.avaliador, avaliador)));
    }
    if (labels.length) await tx.insert(calibration_labels).values(labels);
  });
  return { salvas: labels.length, desconhecidas: ids.filter((id) => !existentes.has(id)) };
}

// ---- comparação ----

export type StageAgreement = {
  stage_id: string;
  n: number;
  exata: number; // fração
  binaria: number; // completo vs. não completo
  ia_mais_generosa: number; // contagem: IA deu status melhor que o humano
  ia_mais_rigida: number;
  matriz: Record<Status, Record<Status, number>>; // [humano][ia]
};

export type Divergencia = { call_id: string; playbook_id: string; stage_id: string; humano: string; ia: string; evidencia?: string; o_que_faltou?: string };

export type CalibrationResult = {
  playbook_id: string;
  calls: number;
  etapas: StageAgreement[];
  geral: { n: number; exata: number; binaria: number; kappa: number | null };
  churn: { n: number; concordancia: number | null; ia_sim_humano_nao: number; ia_nao_humano_sim: number };
  divergencias: Divergencia[];
  sem_analise: string[]; // calls avaliadas sem análise da IA nesse playbook
};

const RANK: Record<Status, number> = { ausente: 0, parcial: 1, completo: 2 };
const emptyMatrix = () => Object.fromEntries(STATUS.map((h) => [h, Object.fromEntries(STATUS.map((i) => [i, 0]))])) as StageAgreement["matriz"];

/** Kappa de Cohen (3 classes): concordância corrigida pelo acaso. */
export function cohenKappa(pairs: Array<[Status, Status]>): number | null {
  if (!pairs.length) return null;
  const n = pairs.length;
  const po = pairs.filter(([h, i]) => h === i).length / n;
  const pe = STATUS.reduce((acc, s) => acc + (pairs.filter(([h]) => h === s).length / n) * (pairs.filter(([, i]) => i === s).length / n), 0);
  return pe === 1 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
}

export async function compareCalibration(db: Db, playbookId: string): Promise<CalibrationResult> {
  const labels = await db.select().from(calibration_labels).where(eq(calibration_labels.playbook_id, playbookId));
  const callIds = [...new Set(labels.map((l) => l.call_id))];
  const an = callIds.length ? await db.select().from(analyses).where(and(eq(analyses.playbook_id, playbookId), inArray(analyses.call_id, callIds))) : [];
  const latest = new Map<string, (typeof an)[number]>();
  for (const a of an.sort((x, y) => x.created_at.localeCompare(y.created_at))) latest.set(a.call_id, a);

  const porEtapa = new Map<string, Array<[Status, Status]>>();
  const divergencias: Divergencia[] = [];
  const churnPairs: Array<[boolean, boolean]> = [];
  for (const l of labels) {
    const a = latest.get(l.call_id);
    if (!a) continue;
    const v = a.result as unknown as VerifiedAnalysis;
    if (l.stage_id === CHURN_ROW) {
      churnPairs.push([!!l.churn, v.risco_churn.length > 0]);
      continue;
    }
    const e = v.etapas.find((x) => x.id === l.stage_id);
    if (!e) continue;
    const pair: [Status, Status] = [l.status as Status, e.status as Status];
    porEtapa.set(l.stage_id, [...(porEtapa.get(l.stage_id) ?? []), pair]);
    if (pair[0] !== pair[1])
      divergencias.push({ call_id: l.call_id, playbook_id: playbookId, stage_id: l.stage_id, humano: pair[0], ia: pair[1], evidencia: e.evidencias[0]?.citacao, o_que_faltou: e.o_que_faltou || undefined });
  }

  const etapas: StageAgreement[] = [...porEtapa].map(([stage_id, pairs]) => {
    const matriz = emptyMatrix();
    for (const [h, i] of pairs) matriz[h][i]++;
    return {
      stage_id,
      n: pairs.length,
      exata: pairs.filter(([h, i]) => h === i).length / pairs.length,
      binaria: pairs.filter(([h, i]) => (h === "completo") === (i === "completo")).length / pairs.length,
      ia_mais_generosa: pairs.filter(([h, i]) => RANK[i] > RANK[h]).length,
      ia_mais_rigida: pairs.filter(([h, i]) => RANK[i] < RANK[h]).length,
      matriz,
    };
  });
  const all = [...porEtapa.values()].flat();
  return {
    playbook_id: playbookId,
    calls: callIds.filter((c) => latest.has(c)).length,
    etapas: etapas.sort((a, b) => a.exata - b.exata),
    geral: {
      n: all.length,
      exata: all.length ? all.filter(([h, i]) => h === i).length / all.length : 0,
      binaria: all.length ? all.filter(([h, i]) => (h === "completo") === (i === "completo")).length / all.length : 0,
      kappa: cohenKappa(all),
    },
    churn: {
      n: churnPairs.length,
      concordancia: churnPairs.length ? churnPairs.filter(([h, i]) => h === i).length / churnPairs.length : null,
      ia_sim_humano_nao: churnPairs.filter(([h, i]) => !h && i).length,
      ia_nao_humano_sim: churnPairs.filter(([h, i]) => h && !i).length,
    },
    divergencias,
    sem_analise: callIds.filter((c) => !latest.has(c)),
  };
}

// ---- estabilidade ----

export type StabilityRow = { call_id: string; playbook_id: string; notas: number[]; variacao: number; etapas_instaveis: string[] };

/** Reanalisa sem tocar na análise oficial; grava em stability_runs. */
export async function runStability(db: Db, callId: string, playbook: Playbook, rodada: number) {
  const call = await db.select().from(calls).where(eq(calls.id, callId)).get();
  if (!call) throw new Error(`Call ${callId} não encontrada`);
  const segs = await loadSegments(db, callId);
  const model = analysisModel();
  const res = await getProvider().complete({
    model, system: buildSystemPrompt(playbook), user: buildUserPrompt(call, segs, playbook.id), schema: AnalysisOutput, effort: ANALYSIS_EFFORT, maxTokens: 64000,
  });
  const v = verifyAnalysis(res.data, segs, playbook);
  const { usd } = await logCost(db, { call_id: callId, etapa: `estabilidade:${playbook.id}`, model, usage: res.usage, usd: res.costUsd, billing: res.billing });
  await db.insert(stability_runs).values({
    call_id: callId, playbook_id: playbook.id, prompt_version: ANALYSIS_PROMPT_VERSION, rodada, nota_aderencia: v.nota_aderencia_0a100,
    etapas: v.etapas.map((e) => ({ id: e.id, status: e.status, nota: e.nota_0a10 })), custo_usd: usd, billing: res.billing,
  });
  return { nota: v.nota_aderencia_0a100, usd };
}

export async function estimateStability(db: Db, callIds: string[], playbook: Playbook, rodadas: number) {
  let usd = 0;
  for (const id of callIds) {
    const call = (await db.select().from(calls).where(eq(calls.id, id)).get())!;
    usd += estimateAnalysis(buildSystemPrompt(playbook), buildUserPrompt(call, await loadSegments(db, id), playbook.id), analysisModel()).usd * rodadas;
  }
  return usd;
}

/** Compara a análise oficial (mesma versão do prompt) com as rodadas de estabilidade. */
export async function stabilityReport(db: Db, limite = 10): Promise<{ rows: StabilityRow[]; limite: number }> {
  const runs = await db.select().from(stability_runs);
  const grupos = new Map<string, typeof runs>();
  for (const r of runs) grupos.set(`${r.call_id}|${r.playbook_id}|${r.prompt_version}`, [...(grupos.get(`${r.call_id}|${r.playbook_id}|${r.prompt_version}`) ?? []), r]);
  const rows: StabilityRow[] = [];
  for (const [k, rs] of grupos) {
    const [call_id, playbook_id, pv] = k.split("|");
    const oficial = await db.select().from(analyses).where(and(eq(analyses.call_id, call_id), eq(analyses.playbook_id, playbook_id), eq(analyses.prompt_version, pv))).get();
    const versoes = [
      ...(oficial?.nota_aderencia != null ? [{ nota: oficial.nota_aderencia, etapas: (oficial.result as unknown as VerifiedAnalysis).etapas.map((e) => ({ id: e.id, status: e.status })) }] : []),
      ...rs.sort((a, b) => a.rodada - b.rodada).map((r) => ({ nota: r.nota_aderencia, etapas: r.etapas })),
    ];
    const notas = versoes.map((v) => v.nota);
    const ids = [...new Set(versoes.flatMap((v) => v.etapas.map((e) => e.id)))];
    rows.push({
      call_id, playbook_id, notas,
      variacao: Math.max(...notas) - Math.min(...notas),
      etapas_instaveis: ids.filter((id) => new Set(versoes.map((v) => v.etapas.find((e) => e.id === id)?.status)).size > 1),
    });
  }
  return { rows: rows.sort((a, b) => b.variacao - a.variacao), limite };
}

// ---- relatório ----

const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n * 100)}%`);

export function renderCalibrationReport(
  results: CalibrationResult[],
  stability: { rows: StabilityRow[]; limite: number },
  opts: { data: string; stageName: (pb: string, id: string) => string; erros?: string[] },
): string {
  const L: string[] = [`# Relatório de calibração — ${opts.data}`, ""];
  L.push("Compara a avaliação humana (CSV) com a análise da IA. Concordância baixa numa etapa = critério ambíguo no playbook ou no prompt.", "");
  if (opts.erros?.length) L.push("## Linhas ignoradas no CSV", "", ...opts.erros.map((e) => `- ${e}`), "");
  if (!results.some((r) => r.geral.n || r.churn.n)) L.push("_Nenhuma avaliação humana importada ainda. Gere o template com `pnpm calibrate --template`._", "");

  for (const r of results) {
    if (!r.geral.n && !r.churn.n) continue;
    const nome = (id: string) => opts.stageName(r.playbook_id, id);
    L.push(`## Playbook ${r.playbook_id} — ${r.calls} call(s) avaliada(s)`, "");
    L.push(`- **Concordância exata:** ${pct(r.geral.exata)} de ${r.geral.n} etapas · **completo vs. não:** ${pct(r.geral.binaria)} · **kappa:** ${r.geral.kappa == null ? "—" : r.geral.kappa.toFixed(2)}`);
    L.push(`- **Churn:** ${r.churn.n ? `${pct(r.churn.concordancia)} de ${r.churn.n} call(s) · IA viu risco e você não: ${r.churn.ia_sim_humano_nao} · você viu e a IA não: ${r.churn.ia_nao_humano_sim}` : "não avaliado"}`);
    if (r.sem_analise.length) L.push(`- Sem análise da IA neste playbook (ignoradas): ${r.sem_analise.join(", ")}`);
    if (r.calls < 10) L.push(`- ⚠️ Amostra pequena (${r.calls} call(s)): a SPEC pede 10–15 para conclusão.`);
    L.push("", "Churn da IA = qualquer risco apontado (amarelo ou vermelho). kappa: < 0,4 fraco · 0,4–0,6 moderado · 0,6–0,8 bom · > 0,8 ótimo.", "");

    L.push("### Por etapa (pior primeiro)", "", "| Etapa | n | Exata | Completo vs. não | IA mais generosa | IA mais rígida |", "|---|---:|---:|---:|---:|---:|");
    for (const e of r.etapas) L.push(`| ${nome(e.stage_id)} | ${e.n} | ${pct(e.exata)} | ${pct(e.binaria)} | ${e.ia_mais_generosa} | ${e.ia_mais_rigida} |`);
    L.push("");
    const ajustar = r.etapas.filter((e) => e.exata < 0.7 && e.n >= 3);
    if (ajustar.length) {
      L.push("### O que ajustar", "");
      for (const e of ajustar)
        L.push(`- **${nome(e.stage_id)}** (${pct(e.exata)}): ${e.ia_mais_generosa > e.ia_mais_rigida ? "a IA dá mais crédito do que você — apertar `completo_quando`." : e.ia_mais_rigida > e.ia_mais_generosa ? "a IA é mais rígida do que você — rever `completo_quando`/`parcial_quando` ou a exigência de fala do lead." : "divergência nos dois sentidos — critério ambíguo; reescrever com exemplos."}`);
      L.push("");
    }
    if (r.churn.ia_sim_humano_nao > r.churn.ia_nao_humano_sim && r.churn.ia_sim_humano_nao >= 2)
      L.push(`- **Churn superdetectado:** a IA apontou risco em ${r.churn.ia_sim_humano_nao} call(s) que você considerou sem risco. Rever exemplos de risco no prompt e em products.yaml.`, "");

    if (r.divergencias.length) {
      L.push("### Divergências", "", "| Call | Etapa | Você | IA | O que a IA usou |", "|---|---|---|---|---|");
      for (const d of r.divergencias.slice(0, 40)) {
        // Etapa ausente: o útil é o que faltou; senão, a citação que a IA usou como evidência.
        const faltou = d.o_que_faltou ? `faltou: ${d.o_que_faltou.slice(0, 140)}` : undefined;
        const citou = d.evidencia ? `“${d.evidencia.slice(0, 140)}”` : undefined;
        const uso = (d.ia === "ausente" ? (faltou ?? citou) : (citou ?? faltou)) ?? "—";
        L.push(`| ${d.call_id} | ${nome(d.stage_id)} | ${d.humano} | ${d.ia} | ${uso.replace(/\|/g, "/").replace(/\n/g, " ")} |`);
      }
      L.push("");
    }
  }

  L.push("## Estabilidade", "");
  if (!stability.rows.length) L.push("_Ainda não rodado. `pnpm calibrate --estabilidade` reanalisa 5 calls duas vezes (consome cota; mostra a estimativa antes)._", "");
  else {
    L.push(`Variação acima de ${stability.limite} pontos = apertar os critérios da etapa instável.`, "", "| Call | Playbook | Notas (oficial, rodadas) | Variação | Etapas que mudaram |", "|---|---|---|---:|---|");
    for (const s of stability.rows)
      L.push(`| ${s.call_id} | ${s.playbook_id} | ${s.notas.map((n) => Math.round(n)).join(" · ")} | ${s.variacao > stability.limite ? "⚠️ " : ""}${Math.round(s.variacao)} | ${s.etapas_instaveis.map((id) => opts.stageName(s.playbook_id, id)).join(", ") || "—"} |`);
    L.push("");
  }
  return L.join("\n");
}
