import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildQuestions, buildState, interpret, nivel, runReliability } from "../src/core/analysis/reliability";
import type { VerifiedAnalysis } from "../src/core/analysis/schema";
import { cost_log, reliability } from "../src/core/db/schema";
import { decide, type FetchLike } from "../src/core/llm/jev";
import type { Playbook } from "../src/core/playbook";
import type { Segment } from "../src/core/types";
import { seed, tempDb } from "./seed";

const playbook = {
  id: "spiced", nome: "SPICED", versao: 1, evidencia_do_lead_obrigatoria: true, objecoes: [],
  etapas: [
    { id: "dor", nome: "Dor", objetivo: "Achar a dor.", completo_quando: "Dor e causa nas palavras do lead.", parcial_quando: "Dor genérica.", sinais_de_evidencia: [], perguntas_exemplo: [], peso: 1 },
    { id: "impacto", nome: "Impacto", objetivo: "Medir o impacto.", completo_quando: "Impacto em R$.", parcial_quando: "Impacto vago.", sinais_de_evidencia: [], perguntas_exemplo: [], peso: 1 },
  ],
} as unknown as Playbook;

const analysis = {
  etapas: [
    { id: "dor", status: "completo", nota_0a10: 9, evidencias: [{ citacao: "x", segment_idx: 1 }], o_que_faltou: "", pergunta_sugerida: "" },
    { id: "impacto", status: "parcial", nota_0a10: 5, evidencias: [{ citacao: "y", segment_idx: 2 }], o_que_faltou: "", pergunta_sugerida: "" },
  ],
  risco_churn: [{ severidade: "vermelho", tipo: "promessa_de_resultado", citacao: "garanto 300 leads", segment_idx: 3, por_que_e_risco: "JUSTIFICATIVA-DO-OPUS", como_deveria_ter_dito: "" }],
  objecoes: [{ tipo: "preco", citacao: "tá caro", segment_idx: 4, tratamento: "TRATAMENTO-DO-OPUS", resolvida: false }],
} as unknown as VerifiedAnalysis;

const rules = { proibidas: ["Número garantido de leads"], permitidas: "fatura auditável" };

describe("perguntas ao Jev", () => {
  const q = buildQuestions(analysis, playbook, rules);
  it("uma escolha por etapa com os critérios do playbook; churn e objeções viram sim/não", () => {
    expect(Object.keys(q)).toEqual(["etapa__dor", "etapa__impacto", "churn__0", "objecao__0__existe", "objecao__0__resolvida"]);
    expect(q.etapa__dor).toMatchObject({ type: "choice", criteria: { completo: "Dor e causa nas palavras do lead.", parcial: "Dor genérica." } });
    expect(q.etapa__dor.instructions).toContain("Só conta o que o LEAD disse");
    expect(q.churn__0).toMatchObject({ type: "noul" });
    expect(q.churn__0.instructions).toContain("Número garantido de leads");
  });
  it("o Jev nunca vê o veredito nem a justificativa do Opus", () => {
    const tudo = JSON.stringify(q);
    expect(tudo).not.toContain("JUSTIFICATIVA-DO-OPUS");
    expect(tudo).not.toContain("TRATAMENTO-DO-OPUS");
    expect(tudo).not.toMatch(/Opus/);
  });
});

describe("estado", () => {
  const segs: Segment[] = [
    { idx: 0, speaker: "Ana", role: "closer", text: "espera um pouco", flags: ["bastidor"] },
    { idx: 1, speaker: "Carlos", role: "cliente", text: "meu email é carlos@empresa.com e o telefone (11) 98765-4321" },
  ];
  it("tira bastidor/ruído e mascara dados pessoais", () => {
    const { state, contexto } = buildState(segs, [1]);
    expect(contexto).toBe("completo");
    expect(state).toBe("[1] (cliente) Carlos: meu email é [EMAIL] e o telefone [TELEFONE]");
  });
  it("call grande demais vira janelas em volta das falas citadas", () => {
    const longa: Segment[] = Array.from({ length: 400 }, (_, i) => ({ idx: i, speaker: "A", role: "closer", text: "palavra ".repeat(100) }));
    const { state, contexto } = buildState(longa, [200]);
    expect(contexto).toBe("trechos");
    expect(state.split("\n").map((l) => l.match(/^\[(\d+)\]/)![1])).toEqual(Array.from({ length: 17 }, (_, i) => String(192 + i)));
  });
});

describe("interpretação", () => {
  it("nível: alta ≥ 0,8 concordando; média abaixo; divergente se discorda", () => {
    expect(nivel(true, 0.8)).toBe("alta");
    expect(nivel(true, 0.79)).toBe("media");
    expect(nivel(false, 0.99)).toBe("divergente");
  });
  it("compara cada resposta com o Opus", () => {
    const items = interpret(analysis, {
      etapa__dor: { type: "choice", choice: "completo", confidence: 0.7, probabilities: { completo: 0.9, parcial: 0.1, ausente: 0 } },
      etapa__impacto: { type: "choice", choice: "ausente", confidence: 0.5, probabilities: { completo: 0, parcial: 0.4, ausente: 0.6 } },
      churn__0: { type: "noul", noul: 0.3 },
      objecao__0__existe: { type: "noul", noul: 0.95 },
      objecao__0__resolvida: { type: "noul", noul: 0.35 },
    });
    expect(items.map((i) => [i.pergunta, i.opus, i.jev, Math.round(i.prob * 100), i.nivel])).toEqual([
      ["etapa__dor", "completo", "completo", 90, "alta"],
      ["etapa__impacto", "parcial", "ausente", 60, "divergente"],
      ["churn__0", "sim", "nao", 70, "divergente"],
      ["objecao__0__existe", "sim", "sim", 95, "alta"],
      ["objecao__0__resolvida", "nao", "nao", 65, "media"],
    ]);
  });
});

describe("cliente e gravação (API simulada)", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  const env = { ...process.env };
  beforeEach(async () => {
    ctx = await tempDb();
    process.env.OPENROUTER_API_KEY = "teste";
  });
  afterEach(() => {
    process.env = { ...env };
    ctx.cleanup();
  });

  it("tenta de novo em 429/529 e falha claro sem crédito", async () => {
    let n = 0;
    const flaky: FetchLike = async () => (++n < 3 ? { ok: false, status: 529, json: async () => ({}), text: async () => "" } : { ok: true, status: 200, json: async () => ({ answers: {}, usage: { input_tokens: 1, output_tokens: 0, cost: 0 } }), text: async () => "" });
    await decide({ state: "x", questions: {} }, { fetch: flaky, sleep: async () => {} });
    expect(n).toBe(3);
    const semCredito: FetchLike = async () => ({ ok: false, status: 402, json: async () => ({}), text: async () => "" });
    await expect(decide({ state: "x", questions: {} }, { fetch: semCredito })).rejects.toThrow("sem créditos");
  });

  it("pede data_collection=deny, grava a confiabilidade e o custo real", async () => {
    await seed(ctx.db, [{ id: "c1", closer: "ana", data: "2026-09-30T10:00:00", nota: 50, classificacao: "critica", etapas: { dor: "completo", impacto: "parcial" }, churnVermelho: 1 }]);
    let body: Record<string, unknown> = {};
    const fake: FetchLike = async (_url, init) => {
      body = JSON.parse(init.body);
      return {
        ok: true, status: 200, text: async () => "",
        json: async () => ({
          id: "gen", model: "typesafe/jev-1.13-20260917", provider: "TypeSafe",
          answers: {
            etapa__dor: { type: "choice", choice: "completo", confidence: 0.9, probabilities: { completo: 0.95, parcial: 0.05, ausente: 0 } },
            etapa__impacto: { type: "choice", choice: "parcial", confidence: 0.4, probabilities: { completo: 0.2, parcial: 0.6, ausente: 0.2 } },
            churn__0: { type: "noul", noul: 0.1 },
          },
          usage: { input_tokens: 9000, output_tokens: 40, cost: 0.000378 },
        }),
      };
    };
    const r = await runReliability(ctx.db, "c1__spiced__analysis.v2", playbook, { fetch: fake });
    expect(body).toMatchObject({ model: "typesafe/jev-1.13", provider: { data_collection: "deny" } });
    expect(r.items.map((i) => i.nivel)).toEqual(["alta", "media", "divergente"]);
    const rows = await ctx.db.select().from(reliability).where(eq(reliability.analysis_id, "c1__spiced__analysis.v2"));
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ kind: "etapa", ref: "dor", nivel: "alta", model: "typesafe/jev-1.13-20260917", contexto: "completo" });
    const custo = (await ctx.db.select().from(cost_log)).find((c) => c.etapa === "confiabilidade:spiced");
    expect(custo).toMatchObject({ custo_usd: 0.000378, tokens_input: 9000, billing: "api" });
    // Rodar de novo substitui, não duplica
    await runReliability(ctx.db, "c1__spiced__analysis.v2", playbook, { fetch: fake });
    expect(await ctx.db.select().from(reliability)).toHaveLength(3);
  });
});
