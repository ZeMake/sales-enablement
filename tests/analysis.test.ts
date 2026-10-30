import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify } from "../src/core/analysis/classify";
import { analyzeCall } from "../src/core/analysis/run";
import type { AnalysisOutput } from "../src/core/analysis/schema";
import { bestWindowScore, findQuote, verifyAnalysis } from "../src/core/analysis/verify";
import { openDb, type Db } from "../src/core/db/client";
import { analyses, churn_flags, evidences, next_steps, stage_results } from "../src/core/db/schema";
import { ingestCall, syncPeople } from "../src/core/ingest";
import { setProvider, type LlmProvider } from "../src/core/llm/provider";
import type { Playbook } from "../src/core/playbook";
import { LocalFolderSource } from "../src/core/sources/local-folder";
import type { Segment } from "../src/core/types";
import { rules, team } from "./fixtures";

// Transcrição sintética já normalizada
const segs: Segment[] = [
  { idx: 0, speaker: "Ana", role: "closer", text: "Vou só conferir a agenda antes do cliente entrar", flags: ["bastidor"] },
  { idx: 1, speaker: "Ana", role: "closer", text: "Boa tarde Carlos, como vocês captam clientes hoje?" },
  { idx: 2, speaker: "Carlos", role: "cliente", text: "Hoje é tudo por indicação, faturamos uns oitenta mil por mês e queremos dobrar até dezembro." },
  { idx: 3, speaker: "Ana", role: "closer", text: "E quanto vocês perdem por mês sem um fluxo previsível de leads?" },
  { idx: 4, speaker: "Carlos", role: "cliente", text: "Acho que uns vinte mil reais por mês em vendas que não acontecem." },
  { idx: 5, speaker: "Ana", role: "closer", text: "Com a gente você vai ter no mínimo cem leads por mês, isso eu te garanto." },
  { idx: 6, speaker: "Carlos", role: "cliente", text: "Tá caro pra mim agora, preciso ver com meu sócio." },
];

const playbook: Playbook = {
  id: "teste", nome: "Teste", versao: 1, evidencia_do_lead_obrigatoria: true, objecoes: [],
  etapas: [
    { id: "situacao", nome: "Situação", objetivo: "", completo_quando: "", parcial_quando: "", sinais_de_evidencia: [], perguntas_exemplo: ["Como captam clientes?"], peso: 1 },
    { id: "impacto", nome: "Impacto", objetivo: "", completo_quando: "", parcial_quando: "", sinais_de_evidencia: [], perguntas_exemplo: [], peso: 1 },
    { id: "decisao", nome: "Decisão", objetivo: "", completo_quando: "", parcial_quando: "", sinais_de_evidencia: [], perguntas_exemplo: ["Quem decide?"], peso: 2 },
  ],
};

function baseOutput(): AnalysisOutput {
  return {
    playbook_id: "teste",
    etapas: [
      { id: "situacao", status: "completo", nota_0a10: 9, evidencias: [{ citacao: "tudo por indicação, faturamos uns oitenta mil por mês", segment_idx: 2 }], o_que_faltou: "", pergunta_sugerida: "" },
      { id: "impacto", status: "completo", nota_0a10: 8, evidencias: [{ citacao: "quanto vocês perdem por mês sem um fluxo previsível de leads", segment_idx: 3 }], o_que_faltou: "", pergunta_sugerida: "" },
      { id: "decisao", status: "parcial", nota_0a10: 7, evidencias: [{ citacao: "o sócio já aprovou o orçamento de dez mil", segment_idx: 6 }], o_que_faltou: "", pergunta_sugerida: "" },
    ],
    nota_aderencia_0a100: 85,
    perguntas_closer: { abertas: 2.4, fechadas: 0 },
    objecoes: [
      { tipo: "preco", citacao: "Tá caro pra mim agora", segment_idx: 6, tratamento: "não tratou", resolvida: false },
      { tipo: "tempo", citacao: "não tenho tempo para isso agora", segment_idx: 6, tratamento: "", resolvida: true },
    ],
    reframe: { ocorreu: true, citacao: "o problema de vocês é processo", segment_idx: 3, qualidade_0a3: 2 },
    custo_da_inacao: { quantificado: true, quem_quantificou: "closer", valor: "20 mil/mês", citacao: "uns vinte mil reais por mês em vendas que não acontecem", segment_idx: 4 },
    cases: { cliente_pediu: false, closer_mostrou: false, momento: null },
    sentimento_cliente: { geral: "interessado", sinais_de_compra: [], momentos: [] },
    risco_churn: [
      { severidade: "vermelho", tipo: "promessa_de_resultado", citacao: "você vai ter no mínimo cem leads por mês, isso eu te garanto", segment_idx: 5, por_que_e_risco: "", como_deveria_ter_dito: "" },
      { severidade: "amarelo", tipo: "outro", citacao: "preciso ver com meu sócio", segment_idx: 6, por_que_e_risco: "", como_deveria_ter_dito: "" },
    ],
    resumo: { contexto: "", dores: [], impacto_financeiro: { descricao: "", valores: [] }, evento_critico: "", decisao: { decisores: [], criterios: [], processo: "", alternativas_avaliadas: [] } },
    proximos_passos: [{ responsavel: "Carlos", tarefa: "falar com o sócio", citacao: "preciso ver com meu sócio" }],
    coaching: { pontos_fortes: ["a", "b", "c", "d"], melhorias: [1, 2, 3, 4].map((n) => ({ ponto: `p${n}`, exemplo_de_frase: "" })) },
    mapa_mental_mermaid: "mindmap\n  root",
    confianca: "alta",
    observacoes: "",
  };
}

describe("bestWindowScore / findQuote", () => {
  it("aceita citação exata e com erro pequeno de transcrição", () => {
    expect(bestWindowScore("faturamos uns oitenta mil por mês", segs[2].text)).toBe(1);
    expect(bestWindowScore("Hoje é tudo por indicação, faturamos uns oitenta mil por mes e queremos dobrar", segs[2].text)).toBeGreaterThanOrEqual(0.85);
  });
  it("rejeita citação inventada", () => {
    expect(bestWindowScore("o sócio já aprovou o orçamento de dez mil", segs[6].text)).toBeLessThan(0.85);
  });
  it("tolera índice errado em até ±2 e corrige o índice", () => {
    expect(findQuote(segs, "uns vinte mil reais por mês", 6)).toMatchObject({ idx: 4, role: "cliente" });
    expect(findQuote(segs, "uns vinte mil reais por mês", 1)).toBeUndefined(); // 3 de distância
  });
  it("aceita citação que atravessa duas falas seguidas", () => {
    expect(findQuote(segs, "leads? Acho que uns vinte mil reais", 3)).toBeDefined();
  });
  it("bastidor não vale como evidência", () => {
    expect(findQuote(segs, "conferir a agenda antes do cliente entrar", 0)).toBeUndefined();
  });
});

describe("verifyAnalysis", () => {
  const v = verifyAnalysis(baseOutput(), segs, playbook);
  const etapa = (id: string) => v.etapas.find((e) => e.id === id)!;

  it("mantém etapa com evidência do lead", () => {
    expect(etapa("situacao")).toMatchObject({ status: "completo", nota_0a10: 9 });
  });
  it("rebaixa completo → parcial quando só o closer falou", () => {
    expect(etapa("impacto")).toMatchObject({ status: "parcial", nota_0a10: 6 });
  });
  it("rebaixa para ausente quando a citação é inventada", () => {
    expect(etapa("decisao")).toMatchObject({ status: "ausente", nota_0a10: 0, evidencias: [] });
    expect(v.verificacao.etapas_rebaixadas.map((r) => r.id).sort()).toEqual(["decisao", "impacto"]);
  });
  it("recalcula a nota em código com pesos", () => {
    expect(v.nota_aderencia_0a100).toBe(37.5); // (9 + 6 + 0×2) / 4 × 10
    expect(v.verificacao.nota_llm).toBe(85);
  });
  it("descarta objeção, reframe e churn sem citação real; churn citando o lead também", () => {
    expect(v.objecoes.map((o) => o.tipo)).toEqual(["preco"]);
    expect(v.reframe).toEqual({ ocorreu: false, qualidade_0a3: 0 });
    expect(v.risco_churn.map((r) => r.tipo)).toEqual(["promessa_de_resultado"]);
  });
  it("corrige quem quantificou pelo papel real do falante", () => {
    expect(v.custo_da_inacao).toMatchObject({ quantificado: true, quem_quantificou: "lead", segment_idx: 4 });
  });
  it("conta citações e limita coaching a 3", () => {
    expect(v.verificacao.citacoes_descartadas).toBe(4); // decisao, objeção tempo, reframe, churn citando o lead
    expect(v.proximos_passos[0].citacao).toBe("preciso ver com meu sócio");
    expect(v.coaching.melhorias.map((m) => m.ponto)).toEqual(["p1", "p2", "p3"]);
    expect(v.coaching.pontos_fortes).toHaveLength(3);
    expect(v.perguntas_closer.abertas).toBe(2);
  });
  it("etapa que o modelo omitiu entra como ausente", () => {
    const out = baseOutput();
    out.etapas = out.etapas.slice(0, 1);
    const r = verifyAnalysis(out, segs, playbook);
    expect(r.etapas.map((e) => [e.id, e.status])).toEqual([["situacao", "completo"], ["impacto", "ausente"], ["decisao", "ausente"]]);
  });
});

describe("classify", () => {
  const c = rules.classificacao;
  const v = verifyAnalysis(baseOutput(), segs, playbook);
  it("crítica com todos os motivos", () => {
    const r = classify(v, { talkRatioCloser: 0.8, tempoEstimado: true }, c);
    expect(r.classificacao).toBe("critica");
    expect(r.motivos.join(" | ")).toMatch(/Nota 38 abaixo da barra.*churn vermelho.*80% \(máx\. 65%\) — tempo estimado/);
  });
  it("atenção quando só há sinais amarelos", () => {
    const ok = verifyAnalysis({ ...baseOutput(), risco_churn: [], objecoes: [] }, segs, { ...playbook, etapas: playbook.etapas.slice(0, 1) });
    expect(ok.nota_aderencia_0a100).toBe(100); // nota só pelo status: completo = 10, mesmo que o modelo tenha dado 9
    const ctx = { talkRatioCloser: 0.5, tempoEstimado: false };
    expect(classify(ok, ctx, c)).toEqual({ classificacao: "ok", motivos: [] });
    expect(classify({ ...ok, confianca: "baixa" }, ctx, c)).toEqual({ classificacao: "atencao", motivos: ["Confiança da análise baixa"] });
    const suja = { ...ok, verificacao: { ...ok.verificacao, citacoes_total: 10, citacoes_descartadas: 4 } };
    expect(classify(suja, ctx, c).motivos[0]).toMatch(/4 de 10 citações/);
  });
  it("% de fala estimado acima do máximo é só alerta; medido de verdade é crítica", () => {
    const ok = verifyAnalysis({ ...baseOutput(), risco_churn: [], objecoes: [] }, segs, { ...playbook, etapas: playbook.etapas.slice(0, 1) });
    expect(classify(ok, { talkRatioCloser: 0.8, tempoEstimado: true }, c)).toEqual({
      classificacao: "atencao",
      motivos: ["Closer falou 80% (máx. 65%) — tempo estimado, só alerta"],
    });
    expect(classify(ok, { talkRatioCloser: 0.8, tempoEstimado: false }, c)).toEqual({
      classificacao: "critica",
      motivos: ["Closer falou 80% (máx. 65%)"],
    });
  });
  it("agrupa tipos de churn repetidos com contagem", () => {
    const ok = verifyAnalysis({ ...baseOutput(), risco_churn: [], objecoes: [] }, segs, { ...playbook, etapas: playbook.etapas.slice(0, 1) });
    const r = (tipo: string) => ({ tipo, severidade: "amarelo" }) as (typeof ok.risco_churn)[number];
    const comChurn = { ...ok, risco_churn: [r("expectativa_desalinhada"), r("prazo_irreal"), r("expectativa_desalinhada")] };
    expect(classify(comChurn, { talkRatioCloser: 0.5, tempoEstimado: false }, c).motivos).toEqual([
      "Risco de churn amarelo: expectativa desalinhada ×2, prazo irreal",
    ]);
  });
});

describe("analyzeCall (provedor falso)", () => {
  let dir: string;
  let db: Db;
  const cwd = process.cwd();
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-analysis-"));
    fs.mkdirSync(path.join(dir, "inbox"));
    db = await openDb(path.join(dir, "test.db"));
    await syncPeople(db, { team, rules });
    process.env.ANALYSIS_MODEL = "claude-opus-5-5";
  });
  afterEach(() => {
    setProvider(undefined);
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("verifica, classifica e grava tudo com custo", async () => {
    const txt = segs.slice(1).map((s) => `${s.speaker === "Ana" ? "Ana Closer" : "Carlos Lead"}: ${s.text}`).join("\n\n");
    fs.writeFileSync(path.join(dir, "inbox", "Reuniao-09-Ana.txt"), txt + "\n\n" + Array(60).fill("Carlos Lead: mais contexto sobre a operação e o time comercial da empresa").join("\n\n"));
    const src = new LocalFolderSource(path.join(dir, "inbox"), team);
    const [sc] = (await src.list()).calls;
    await ingestCall(db, { team, rules }, src, sc, { llm: false, processedDir: path.join(dir, "p"), mediaDir: path.join(dir, "m") });

    let seenSystem = "";
    const fake: LlmProvider = {
      name: "claude-cli",
      async complete(req) {
        seenSystem = req.system;
        const out = baseOutput();
        // índices da call ingerida: sem bastidor, então tudo desloca -1
        for (const e of out.etapas) for (const ev of e.evidencias) ev.segment_idx -= 1;
        out.risco_churn[0].segment_idx = 4;
        out.objecoes[0].segment_idx = 5;
        out.custo_da_inacao.segment_idx = 3;
        return { data: req.schema.parse(out), model: req.model, usage: { input_tokens: 1000, output_tokens: 500 }, costUsd: 0.05, billing: "assinatura" };
      },
    };
    setProvider(fake);
    const r = await analyzeCall(db, { team, rules }, "reuniao-09-ana", playbook);

    expect(seenSystem).toContain('Etapa "decisao"');
    expect(r.classificacao).toBe("critica");
    expect(r.billing).toBe("assinatura");
    const a = (await db.select().from(analyses).where(eq(analyses.id, r.analysis_id)).get())!;
    expect(a).toMatchObject({ provider: "claude-cli", nota_llm: 85, custo_usd: 0.05, prompt_version: "analysis.v2" });
    expect((await db.select().from(stage_results).all()).find((s) => s.stage_id === "decisao")).toMatchObject({ status: "ausente", rebaixada: true });
    expect((await db.select().from(evidences).where(eq(evidences.valida, false)).all()).length).toBe(r.citacoes_descartadas);
    expect((await db.select().from(churn_flags).all()).map((c) => c.tipo)).toEqual(["promessa_de_resultado"]);
    expect((await db.select().from(next_steps).all())[0]).toMatchObject({ tarefa: "falar com o sócio", status: "pendente" });

    // reanálise substitui, não duplica
    await analyzeCall(db, { team, rules }, "reuniao-09-ana", playbook);
    expect((await db.select().from(stage_results).all()).length).toBe(3);
  });
});
