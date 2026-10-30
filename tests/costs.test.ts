import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cachePct, costSummary } from "../src/core/costs";
import { cost_log } from "../src/core/db/schema";
import { seed, tempDb } from "./seed";

describe("costSummary", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    ctx = await tempDb();
    await seed(ctx.db, [
      { id: "c1", closer: "ana", data: "2026-09-29T15:00:00", nota: 50, classificacao: "critica", etapas: { dor: "completo" }, custo: 0.4 },
      { id: "c2", closer: "bia", data: "2026-09-30T15:00:00", nota: 70, classificacao: "ok", etapas: { dor: "completo" }, custo: 0.6 },
    ]);
    await ctx.db.insert(cost_log).values([
      { call_id: "c1", etapa: "triagem", model: "claude-haiku-4-5", billing: "api", tokens_input: 1000, tokens_output: 100, custo_usd: 0.1, custo_brl: 0.54, created_at: "2026-09-29T15:01:00" },
      { etapa: "outro", model: "claude-haiku-4-5", billing: "api", tokens_input: 10, tokens_output: 1, custo_usd: 0.01, custo_brl: 0.054, created_at: "2026-09-30T10:00:00" },
    ]);
  });
  afterEach(() => ctx.cleanup());

  it("soma por call, dia, closer e etapa; separa API real de assinatura", async () => {
    const c = await costSummary(ctx.db, { id: "gestora", papeis: ["admin", "gestor"] });
    expect(c.total.chamadas).toBe(4);
    expect(c.total.usd).toBeCloseTo(1.11);
    expect(c.total.api_usd).toBeCloseTo(0.11);
    expect(c.total.assinatura_usd).toBeCloseTo(1.0);
    expect(c.por_call_media).toEqual({ usd: 0.55, calls: 2 }); // (0.4 + 0.1 + 0.6) / 2; custo sem call fica fora da média
    expect(c.por_dia.map((d) => [d.chave, Number(d.usd.toFixed(2))])).toEqual([["2026-09-29", 0.5], ["2026-09-30", 0.61]]);
    expect(c.por_closer.map((l) => l.label)).toEqual(["Bia Vendas", "Ana Closer", "(sem closer)"]);
    expect(c.por_etapa.find((l) => l.chave === "triagem")!.tokens).toEqual({ input: 1000, output: 100, cache_read: 0, cache_write: 0 });
    expect(c.por_call.find((l) => l.chave === "c1")).toMatchObject({ chamadas: 2, closer: "Ana Closer" });
  });

  it("filtra período e respeita escopo (closer não vê custo dos outros nem custo sem call)", async () => {
    expect((await costSummary(ctx.db, { id: "gestora", papeis: ["admin"] }, { de: "2026-09-30" })).total.chamadas).toBe(2);
    const bia = await costSummary(ctx.db, { id: "bia", papeis: ["closer"] });
    expect(bia.por_call.map((l) => l.chave)).toEqual(["c2"]);
  });

  it("% de entrada lida do cache", () => {
    expect(cachePct({ input: 10, cache_write: 40, cache_read: 50, output: 999 })).toBe(0.5);
    expect(cachePct({ input: 0, cache_write: 0, cache_read: 0, output: 1 })).toBeNull();
  });
});
