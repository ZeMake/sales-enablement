import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classify } from "../src/core/analysis/classify";
import { consolidarEtapas, notaPorStatus, recompute, validarNota } from "../src/core/analysis/score";
import type { VerifiedAnalysis } from "../src/core/analysis/schema";
import { analyses, calibration_labels, reliability, stage_results } from "../src/core/db/schema";
import type { Playbook } from "../src/core/playbook";
import { eq } from "drizzle-orm";
import { rules, team } from "./fixtures";
import { seed, tempDb } from "./seed";

const pb = {
  id: "spiced", nome: "SPICED", versao: 1, evidencia_do_lead_obrigatoria: true, objecoes: [],
  etapas: [{ id: "dor", peso: 1 }, { id: "impacto", peso: 1 }, { id: "decisao", peso: 2 }],
} as unknown as Playbook;

describe("nota só pelo status", () => {
  it("completo 10 · parcial 5 · ausente 0, com pesos", () => {
    expect(notaPorStatus({ dor: "completo", impacto: "parcial", decisao: "ausente" }, pb)).toBe(37.5); // (10 + 5 + 0×2) / 4 × 10
    expect(notaPorStatus({ dor: "completo", impacto: "completo", decisao: "completo" }, pb)).toBe(100);
  });
});

describe("status final e validação", () => {
  const etapas = [{ id: "dor", status: "completo" }, { id: "impacto", status: "parcial" }, { id: "decisao", status: "parcial" }];
  it("humano > concordância > revisão; faixa entre Opus e Jev", () => {
    const finais = consolidarEtapas(
      etapas,
      [{ ref: "dor", jev: "completo", nivel: "alta" }, { ref: "impacto", jev: "ausente", nivel: "divergente" }, { ref: "decisao", jev: "completo", nivel: "divergente" }],
      [{ stage_id: "decisao", status: "completo" }],
    );
    expect(finais.map((f) => [f.id, f.final, f.fonte])).toEqual([["dor", "completo", "concordancia"], ["impacto", null, "revisao"], ["decisao", "completo", "humano"]]);
    expect(validarNota(finais, pb)).toEqual({ nota: 87.5, nota_min: 75, nota_max: 87.5, validacao: "provisoria", em_revisao: ["impacto"] });
  });
  it("sem Jev em alguma etapa: sem_jev; tudo concordando: validada", () => {
    expect(validarNota(consolidarEtapas(etapas, [], []), pb).validacao).toBe("sem_jev");
    const todos = etapas.map((e) => ({ ref: e.id, jev: e.status, nivel: "media" }));
    expect(validarNota(consolidarEtapas(etapas, todos, []), pb)).toMatchObject({ validacao: "validada", em_revisao: [], nota_min: 62.5, nota_max: 62.5 });
  });
});

describe("churn crítico só com confirmação do Jev", () => {
  const a = {
    nota_aderencia_0a100: 80, etapas: [{ id: "dor", status: "completo" }], objecoes: [], confianca: "alta",
    verificacao: { citacoes_total: 0, citacoes_descartadas: 0 },
    risco_churn: [{ severidade: "vermelho", tipo: "promessa_de_resultado" }, { severidade: "vermelho", tipo: "funcionalidade_inexistente" }, { severidade: "amarelo", tipo: "prazo_irreal" }],
  } as unknown as VerifiedAnalysis;
  const ctx = { talkRatioCloser: 0.5, tempoEstimado: false };
  it("sem Jev: vale como veio, e não diz que foi confirmado", () => {
    expect(classify(a, ctx, rules.classificacao).classificacao).toBe("critica");
    const semAvaliacao = classify(a, { ...ctx, churnJev: {} }, rules.classificacao);
    expect(semAvaliacao.motivos[0]).toBe("Risco de churn vermelho: promessa de resultado, funcionalidade inexistente");
  });
  it("vermelho que o Jev não confirma vira atenção para revisar", () => {
    const r = classify(a, { ...ctx, churnJev: { 0: "divergente", 1: "divergente", 2: "media" } }, rules.classificacao);
    expect(r).toEqual({
      classificacao: "atencao",
      motivos: ["Risco de churn amarelo: prazo irreal", "2 risco(s) de churn não confirmado(s) pelo Jev — revisar (vermelho: promessa de resultado, funcionalidade inexistente)"],
    });
  });
  it("vermelho confirmado continua crítico", () => {
    const r = classify(a, { ...ctx, churnJev: { 0: "media", 1: "divergente", 2: "divergente" } }, rules.classificacao);
    expect(r.classificacao).toBe("critica");
    expect(r.motivos[0]).toBe("Risco de churn vermelho (confirmado pelo Jev): promessa de resultado");
  });
});

describe("recompute (banco)", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  const id = "c1__spiced__analysis.v2";
  beforeEach(async () => {
    ctx = await tempDb();
    await seed(ctx.db, [{ id: "c1", closer: "ana", data: "2026-09-30T10:00:00", nota: 33, classificacao: "critica", etapas: { dor: "completo", impacto: "parcial", decisao: "ausente" }, churnVermelho: 1 }]);
  });
  afterEach(() => ctx.cleanup());

  it("Jev + revisão humana fecham a nota; etapas e classificação acompanham", async () => {
    const cfg = { team, rules };
    let r = await recompute(ctx.db, cfg, id, pb);
    expect(r).toMatchObject({ nota: 37.5, validacao: "sem_jev", classificacao: "critica" });

    await ctx.db.insert(reliability).values([
      { analysis_id: id, kind: "etapa", ref: "dor", opus: "completo", jev: "completo", prob: 0.9, nivel: "alta", model: "jev", contexto: "completo" },
      { analysis_id: id, kind: "etapa", ref: "impacto", opus: "parcial", jev: "parcial", prob: 0.7, nivel: "media", model: "jev", contexto: "completo" },
      { analysis_id: id, kind: "etapa", ref: "decisao", opus: "ausente", jev: "completo", prob: 0.7, nivel: "divergente", model: "jev", contexto: "completo" },
      { analysis_id: id, kind: "churn", ref: "0", opus: "sim", jev: "nao", prob: 0.8, nivel: "divergente", model: "jev", contexto: "completo" },
    ]);
    r = await recompute(ctx.db, cfg, id, pb);
    expect(r).toMatchObject({ nota: 37.5, nota_min: 37.5, nota_max: 87.5, validacao: "provisoria", em_revisao: ["decisao"] });
    expect(r.motivos).toContain("1 risco(s) de churn não confirmado(s) pelo Jev — revisar (vermelho: promessa de resultado)");

    await ctx.db.insert(calibration_labels).values({ call_id: "c1", playbook_id: "spiced", stage_id: "decisao", status: "parcial", avaliador: "victor" });
    r = await recompute(ctx.db, cfg, id, pb);
    expect(r).toMatchObject({ nota: 62.5, nota_min: 62.5, nota_max: 62.5, validacao: "validada", classificacao: "atencao" }); // 62,5 < 70 e um risco não confirmado
    const row = (await ctx.db.select().from(analyses).where(eq(analyses.id, id)).get())!;
    expect(row).toMatchObject({ nota_aderencia: 62.5, validacao: "validada", classificacao: "atencao" }); // 62,5 < 70 e um risco não confirmado
    expect((await ctx.db.select().from(stage_results).where(eq(stage_results.stage_id, "decisao")).get())).toMatchObject({ status: "parcial", nota: 5 });
  });
});
