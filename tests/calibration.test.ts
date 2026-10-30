import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CHURN_ROW, calibrationTemplate, cohenKappa, compareCalibration, parseCsv, parseLabels, renderCalibrationReport, saveLabels, stabilityReport,
} from "../src/core/calibration";
import { stability_runs } from "../src/core/db/schema";
import type { Playbook } from "../src/core/playbook";
import { seed, tempDb } from "./seed";

describe("CSV", () => {
  it("vírgula, aspas com vírgula/aspas dentro e BOM", () => {
    const rows = parseCsv('﻿call_id,lead,avaliacao\nc1,"Silva, João ""JJ""",completo\n\nc2,Ana,parcial\n');
    expect(rows).toEqual([
      { call_id: "c1", lead: 'Silva, João "JJ"', avaliacao: "completo" },
      { call_id: "c2", lead: "Ana", avaliacao: "parcial" },
    ]);
  });
  it("ponto e vírgula (Excel pt-BR) e CRLF", () => {
    expect(parseCsv("call_id;avaliacao\r\nc1;Ausente\r\n")).toEqual([{ call_id: "c1", avaliacao: "Ausente" }]);
  });
});

describe("parseLabels", () => {
  it("normaliza, ignora vazios e aponta erros", () => {
    const { labels, erros } = parseLabels([
      { call_id: "c1", playbook: "spiced", etapa: "dor", avaliacao: "Completo" },
      { call_id: "c1", playbook: "spiced", etapa: "impacto", avaliacao: "" },
      { call_id: "c1", playbook: "spiced", etapa: CHURN_ROW, avaliacao: "Não" },
      { call_id: "c1", playbook: "spiced", etapa: "decisao", avaliacao: "talvez" },
    ]);
    expect(labels).toEqual([
      { call_id: "c1", playbook_id: "spiced", stage_id: "dor", status: "completo", churn: null, avaliador: "victor" },
      { call_id: "c1", playbook_id: "spiced", stage_id: CHURN_ROW, status: "nao", churn: false, avaliador: "victor" },
    ]);
    expect(erros).toEqual(['linha 5 (c1 · decisao): status deve ser completo, parcial ou ausente (veio "talvez")']);
  });
});

describe("kappa", () => {
  it("1 com concordância total, 0 quando é só acaso", () => {
    expect(cohenKappa([["completo", "completo"], ["ausente", "ausente"]])).toBe(1);
    expect(cohenKappa([["completo", "completo"], ["completo", "ausente"], ["ausente", "completo"], ["ausente", "ausente"]])).toBe(0);
    expect(cohenKappa([])).toBeNull();
  });
});

describe("comparação com a IA", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  const pb = { id: "spiced", nome: "SPICED", versao: 1, evidencia_do_lead_obrigatoria: true, objecoes: [], etapas: [
    { id: "dor", nome: "Dor" }, { id: "impacto", nome: "Impacto" },
  ] } as unknown as Playbook;
  beforeEach(async () => {
    ctx = await tempDb();
    await seed(ctx.db, [
      { id: "c1", closer: "ana", data: "2026-09-30T10:00:00", nota: 50, classificacao: "critica", etapas: { dor: "completo", impacto: "ausente" }, churnVermelho: 1 },
      { id: "c2", closer: "bia", data: "2026-09-30T11:00:00", nota: 70, classificacao: "atencao", etapas: { dor: "completo", impacto: "parcial" } },
    ]);
  });
  afterEach(() => ctx.cleanup());

  it("template sem a resposta da IA", async () => {
    const csv = await calibrationTemplate(ctx.db, [pb]);
    const rows = parseCsv(csv);
    expect(rows).toHaveLength(6); // 2 calls × (2 etapas + churn)
    expect(rows.every((r) => r.avaliacao === "")).toBe(true);
    expect(csv).not.toMatch(/completo|parcial|ausente/);
  });

  it("concordância por etapa, sentido da divergência e churn", async () => {
    const { labels } = parseLabels([
      { call_id: "c1", playbook: "spiced", etapa: "dor", avaliacao: "parcial" }, // IA: completo → mais generosa
      { call_id: "c1", playbook: "spiced", etapa: "impacto", avaliacao: "ausente" },
      { call_id: "c2", playbook: "spiced", etapa: "dor", avaliacao: "completo" },
      { call_id: "c2", playbook: "spiced", etapa: "impacto", avaliacao: "completo" }, // IA: parcial → mais rígida
      { call_id: "c1", playbook: "spiced", etapa: CHURN_ROW, avaliacao: "nao" }, // IA: sim
      { call_id: "c2", playbook: "spiced", etapa: CHURN_ROW, avaliacao: "nao" },
      { call_id: "c9", playbook: "spiced", etapa: "dor", avaliacao: "completo" }, // call que não existe
    ]);
    expect(await saveLabels(ctx.db, labels)).toEqual({ salvas: 6, desconhecidas: ["c9"] });
    await saveLabels(ctx.db, labels); // reimportar substitui, não duplica
    const r = await compareCalibration(ctx.db, "spiced");
    expect(r.calls).toBe(2);
    expect(r.sem_analise).toEqual([]);
    expect(r.geral).toMatchObject({ n: 4, exata: 0.5, binaria: 0.5 });
    expect(r.etapas.find((e) => e.stage_id === "dor")).toMatchObject({ n: 2, exata: 0.5, ia_mais_generosa: 1, ia_mais_rigida: 0 });
    expect(r.etapas.find((e) => e.stage_id === "impacto")).toMatchObject({ ia_mais_generosa: 0, ia_mais_rigida: 1 });
    expect(r.churn).toEqual({ n: 2, concordancia: 0.5, ia_sim_humano_nao: 1, ia_nao_humano_sim: 0 });
    expect(r.divergencias.map((d) => [d.call_id, d.stage_id, d.humano, d.ia])).toEqual([["c1", "dor", "parcial", "completo"], ["c2", "impacto", "completo", "parcial"]]);

    const md = renderCalibrationReport([r], await stabilityReport(ctx.db), { data: "2026-09-30", stageName: (_, id) => (id === "dor" ? "Dor" : "Impacto") });
    expect(md).toContain("Concordância exata:** 50% de 4 etapas");
    expect(md).toContain("Amostra pequena (2 call(s))");
    expect(md).toContain("| c1 | Dor | parcial | completo | “evidência de dor” |");
    expect(md).toContain("Ainda não rodado");
  });

  it("estabilidade compara a análise oficial com as rodadas", async () => {
    await ctx.db.insert(stability_runs).values([
      { call_id: "c1", playbook_id: "spiced", prompt_version: "analysis.v2", rodada: 1, nota_aderencia: 52, etapas: [{ id: "dor", status: "completo", nota: 9 }, { id: "impacto", status: "ausente", nota: 0 }], custo_usd: 0.4, billing: "assinatura" },
      { call_id: "c1", playbook_id: "spiced", prompt_version: "analysis.v2", rodada: 2, nota_aderencia: 65, etapas: [{ id: "dor", status: "completo", nota: 9 }, { id: "impacto", status: "parcial", nota: 5 }], custo_usd: 0.4, billing: "assinatura" },
    ]);
    const s = await stabilityReport(ctx.db);
    expect(s.rows).toEqual([{ call_id: "c1", playbook_id: "spiced", notas: [50, 52, 65], variacao: 15, etapas_instaveis: ["impacto"] }]);
    const md = renderCalibrationReport([], s, { data: "x", stageName: (_, id) => id });
    expect(md).toContain("| c1 | spiced | 50 · 52 · 65 | ⚠️ 15 | impacto |");
  });
});
