import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { compareClosers } from "../src/core/queries";
import { seed, tempDb } from "./seed";

describe("compareClosers", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    ctx = await tempDb();
    await seed(ctx.db, [
      { id: "a1", closer: "ana", data: "2026-09-01", desfecho: "ganho", nota: 80, classificacao: "ok", etapas: { dor: "completo", impacto: "completo" } },
      { id: "a2", closer: "ana", data: "2026-09-02", desfecho: "perdido", nota: 40, classificacao: "critica", etapas: { dor: "completo", impacto: "ausente" }, churnVermelho: 1 },
      { id: "b1", closer: "bia", data: "2026-09-03", nota: 70, classificacao: "ok", etapas: { dor: "parcial", impacto: "completo" } },
    ]);
  });
  afterEach(() => ctx.cleanup());

  it("indicadores e cobertura por etapa de cada closer, ordenados pela nota", async () => {
    const cs = await compareClosers(ctx.db, { id: "gestora", papeis: ["admin", "gestor"] }, "spiced", 60);
    expect(cs.map((c) => c.id)).toEqual(["bia", "ana"]);
    const ana = cs.find((c) => c.id === "ana")!;
    expect(ana).toMatchObject({ analisadas: 2, nota_media: 60, abaixo_pct: 0.5, criticas: 1, churn_vermelho_calls: 1, conversao: { ganhas: 1, com_desfecho: 2 } });
    expect(ana.etapas.dor).toMatchObject({ completo_pct: 1, n: 2 });
    expect(ana.etapas.impacto).toMatchObject({ completo_pct: 0.5, n: 2 });
  });

  it("closer só se vê", async () => {
    const cs = await compareClosers(ctx.db, { id: "bia", papeis: ["closer"] }, "spiced", 60);
    expect(cs.map((c) => c.id)).toEqual(["bia"]);
  });
});
