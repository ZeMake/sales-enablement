import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildInsights, grupo, predicao, quintis } from "../src/core/insights";
import { seed, tempDb } from "./seed";

describe("estatística", () => {
  it("grupo marca amostra pequena", () => {
    expect(grupo("x", [true, false, false, true])).toEqual({ label: "x", n: 4, ganhas: 2, conversao: 0.5, pequeno: true });
    expect(grupo("vazio", [])).toMatchObject({ n: 0, conversao: null });
  });
  it("quintis com faixas de tamanho parecido, ordenadas", () => {
    const pts = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100].map((nota, i) => ({ nota, ganho: i >= 6 }));
    const q = quintis(pts);
    expect(q.map((x) => [x.label, x.n, x.conversao])).toEqual([["10–20", 2, 0], ["30–40", 2, 0], ["50–60", 2, 0], ["70–80", 2, 1], ["90–100", 2, 1]]);
    expect(quintis([{ nota: 50, ganho: true }, { nota: 60, ganho: false }]).map((x) => x.label)).toEqual(["50", "60"]);
  });
  it("AUC e correlação", () => {
    expect(predicao([{ nota: 80, ganho: true }, { nota: 40, ganho: false }])).toMatchObject({ auc: 1, correlacao: 1, media_ganho: 80, media_perdido: 40 });
    expect(predicao([{ nota: 40, ganho: true }, { nota: 80, ganho: false }]).auc).toBe(0);
    expect(predicao([{ nota: 50, ganho: true }, { nota: 50, ganho: false }])).toMatchObject({ auc: 0.5, correlacao: 0 });
    expect(predicao([{ nota: 50, ganho: true }])).toMatchObject({ auc: null, correlacao: null });
  });
});

describe("buildInsights", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    ctx = await tempDb();
    await seed(ctx.db, [
      { id: "g1", closer: "ana", data: "2026-09-01", desfecho: "ganho", nota: 80, classificacao: "ok", etapas: { dor: "completo", impacto: "completo" }, reframe: true, custoInacao: true, caseMomento: "a_pedido" },
      { id: "g2", closer: "bia", data: "2026-09-02", desfecho: "ganho", nota: 70, classificacao: "ok", etapas: { dor: "completo", impacto: "parcial" }, caseMomento: "proativo" },
      { id: "p1", closer: "ana", data: "2026-09-03", desfecho: "perdido", nota: 40, classificacao: "critica", etapas: { dor: "parcial", impacto: "ausente" } },
      { id: "a1", closer: "ana", data: "2026-09-04", desfecho: "em_andamento", nota: 90, classificacao: "ok", etapas: { dor: "completo", impacto: "completo" } },
      { id: "s1", closer: "bia", data: "2026-09-05", nota: 90, classificacao: "ok", etapas: { dor: "completo", impacto: "completo" } },
      { id: "g1", closer: "ana", data: "2026-09-01", playbook: "make-closer", nota: 60, classificacao: "atencao", etapas: { e1: "completo" } },
    ]);
  });
  afterEach(() => ctx.cleanup());

  it("só ganho/perdido entram; etapas, hipóteses e comparação entre playbooks", async () => {
    const viewer = { id: "gestora", papeis: ["admin", "gestor"] };
    const pbs = [{ id: "spiced", etapas: [{ id: "dor" }, { id: "impacto" }] }, { id: "make-closer", etapas: [{ id: "e1" }] }];
    const ins = await buildInsights(ctx.db, viewer, pbs);
    expect(ins).toMatchObject({ com_desfecho: 3, sem_desfecho: 1, em_andamento: 1 });
    const sp = ins.playbooks[0];
    expect(sp.n).toBe(3);
    expect(sp.predicao.auc).toBe(1);
    expect(sp.etapas.find((e) => e.id === "dor")).toMatchObject({ completa: { n: 2, conversao: 1 }, nao: { n: 1, conversao: 0 }, diferenca: 1 });
    const caseH = sp.hipoteses.find((h) => h.id === "case")!;
    expect(caseH.grupos.map((g) => [g.label, g.n])).toEqual([["a pedido do lead", 1], ["proativo", 1], ["sem case", 1]]);
    expect(sp.hipoteses.find((h) => h.id === "reframe")!.grupos[0]).toMatchObject({ n: 1, conversao: 1 });
    // Comparação: só g1 tem as duas análises
    expect(ins.comparacao!.map((c) => [c.playbook_id, c.n])).toEqual([["spiced", 1], ["make-closer", 1]]);
  });

  it("closer só enxerga as próprias calls", async () => {
    const ins = await buildInsights(ctx.db, { id: "bia", papeis: ["closer"] }, [{ id: "spiced", etapas: [{ id: "dor" }] }]);
    expect(ins.com_desfecho).toBe(1);
  });
});
