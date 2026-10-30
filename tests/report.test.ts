import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/core/db/client";
import { notifications } from "../src/core/db/schema";
import { buildAlerts, alertAnalysis } from "../src/core/notify/alerts";
import { dispatch, toSlackBlocks, toText, type Notificacao, type Notifier } from "../src/core/notify/index";
import { buildDailyReport, dailyNotification } from "../src/core/report/daily";
import { parsePrazo } from "../src/core/report/prazo";
import { rules, team } from "./fixtures";
import { seed, tempDb } from "./seed";

describe("parsePrazo (call numa quarta, 30/09/2026)", () => {
  const p = (t: string | null) => parsePrazo(t, "2026-09-30T15:00:00");
  it("mesmo dia", () => {
    expect(p("logo após a call")).toBe("2026-09-30");
    expect(p("No mesmo dia")).toBe("2026-09-30");
  });
  it("vários prazos: vale o mais tardio", () => expect(p("Hoje à tarde ou amanhã")).toBe("2026-10-01"));
  it("dia da semana é o próximo, nunca o próprio dia", () => {
    expect(p("Sexta-feira")).toBe("2026-10-02");
    expect(p("quarta")).toBe("2026-10-07");
  });
  it("semana, fim de semana, dias e mês", () => {
    expect(p("Até o fim da semana")).toBe("2026-10-02");
    expect(p("até o fim da semana seguinte")).toBe("2026-10-09");
    expect(p("uma semana")).toBe("2026-10-07");
    expect(p("em até 10 dias")).toBe("2026-10-10");
    expect(p("mês que vem")).toBe("2026-10-31");
  });
  it("datas explícitas e 'dia N'", () => {
    expect(p("dia 7")).toBe("2026-10-07");
    expect(p("dia 30")).toBe("2026-09-30");
    expect(p("15/10")).toBe("2026-10-15");
    expect(p("2026-11-03")).toBe("2026-11-03");
  });
  it("vago ou condicional não vira data", () => {
    for (const t of [null, "", "Sem prazo definido; condição válida até amanhã", "logo após receber os dados", "depois que o material chegar", "não definido"])
      expect(p(t)).toBeNull();
  });
});

const msg = (over: Partial<Notificacao> = {}): Notificacao => ({
  tipo: "alerta_critica",
  destinatario: { id: "gestora", nome: "Gestora Teste", slack: "U123", whatsapp: "" },
  chave: "alerta:c1",
  call_id: undefined,
  titulo: "Alerta: call crítica",
  resumo: "Nota 40",
  secoes: [{ titulo: "Por quê", itens: ["Nota 40 abaixo da barra", "a < b"] }, { titulo: "Vazia", itens: [] }],
  links: [{ label: "Abrir a call", url: "http://x/calls/c1" }],
  ...over,
});

describe("formatação", () => {
  it("texto simples, sem seção vazia", () => {
    const t = toText(msg());
    expect(t).toContain("- Nota 40 abaixo da barra");
    expect(t).not.toContain("Vazia");
    expect(t).toContain("Abrir a call: http://x/calls/c1");
  });
  it("Slack: header, menção e escape", () => {
    const s = toSlackBlocks(msg());
    expect(s.text).toBe("<@U123> Alerta: call crítica");
    expect(JSON.stringify(s.blocks)).toContain("a &lt; b");
    expect(s.blocks.at(-1)).toMatchObject({ type: "actions" });
  });
});

describe("dispatch", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    ctx = await tempDb();
  });
  afterEach(() => ctx.cleanup());

  it("dry-run grava arquivo por canal e não envia; repetir a chave não duplica", async () => {
    const enviados: string[] = [];
    const spy: Notifier = { canal: "slack", async send(n) { enviados.push(n.chave); }, preview: (n) => ({ ext: "json", body: JSON.stringify(toSlackBlocks(n)) }) };
    const outDir = path.join(ctx.dir, "out");
    const r1 = await dispatch(ctx.db, msg(), { notifiers: [spy], dryRun: true, outDir });
    expect(r1[0].status).toBe("gerada");
    expect(fs.existsSync(r1[0].arquivo!)).toBe(true);
    expect(enviados).toEqual([]);
    expect((await dispatch(ctx.db, msg(), { notifiers: [spy], dryRun: true, outDir }))[0].status).toBe("duplicada");
    expect((await dispatch(ctx.db, msg(), { notifiers: [spy], dryRun: true, outDir, replace: true }))[0].status).toBe("gerada");
    expect(await ctx.db.select().from(notifications)).toHaveLength(1);
  });

  it("fora do dry-run envia; erro do canal fica registrado", async () => {
    const ok: Notifier = { canal: "slack", async send() {}, preview: () => ({ ext: "txt", body: "" }) };
    const falha: Notifier = { canal: "whatsapp", async send() { throw new Error("provedor fora"); }, preview: () => ({ ext: "txt", body: "" }) };
    const r = await dispatch(ctx.db, msg(), { notifiers: [ok, falha], dryRun: false });
    expect(r.map((x) => [x.canal, x.status])).toEqual([["slack", "enviada"], ["whatsapp", "erro"]]);
    expect((await ctx.db.select().from(notifications)).find((n) => n.canal === "whatsapp")?.erro).toBe("provedor fora");
  });
});

describe("alertas e relatório diário", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  let db: Db;
  const cfg = { team, rules };
  beforeEach(async () => {
    ctx = await tempDb();
    db = ctx.db;
    await seed(db, [
      { id: "c1", closer: "ana", data: "2026-09-30T14:00:00", nota: 40, classificacao: "critica", motivos: ["Nota 40 abaixo da barra mínima (60)", "Nenhuma etapa completa"], etapas: { situacao: "parcial", impacto: "ausente" }, churnVermelho: 2,
        steps: [{ tarefa: "mandar proposta", prazo: "amanhã" }, { tarefa: "ligar", prazo: "sem prazo" }, { tarefa: "feito já", prazo: "hoje", status: "feito" }] },
      { id: "c2", closer: "bia", data: "2026-09-30T16:00:00", nota: 80, classificacao: "ok", etapas: { situacao: "completo", impacto: "parcial" } },
      { id: "c3", closer: "bia", data: "2026-09-29T10:00:00", nota: 50, classificacao: "critica", etapas: { situacao: "completo", impacto: "completo" } },
      { id: "c4", closer: "ana", data: "2026-09-30T09:00:00", playbook: "make-closer", nota: 90, classificacao: "ok", etapas: { e1: "completo" } },
    ]);
  });
  afterEach(() => ctx.cleanup());

  it("alerta só para crítica/churn vermelho, um por call × gestor", async () => {
    expect(await buildAlerts(db, cfg, "c2__spiced__analysis.v2")).toEqual([]);
    const [a] = await buildAlerts(db, cfg, "c1__spiced__analysis.v2");
    expect(a).toMatchObject({ chave: "alerta:c1", destinatario: { id: "gestora" }, titulo: expect.stringContaining("churn vermelho — Ana Closer com Lead c1") });
    expect(toText(a)).toContain("garanto resultado");
    const opts = { notifiers: [{ canal: "painel", async send() {}, preview: () => ({ ext: "txt", body: "" }) }] as Notifier[], dryRun: true, outDir: path.join(ctx.dir, "o") };
    await alertAnalysis(db, cfg, "c1__spiced__analysis.v2", opts);
    const again = await alertAnalysis(db, cfg, "c1__spiced__analysis.v2", opts);
    expect(again[0].results[0].status).toBe("duplicada");
  });

  it("relatório do dia: calls do dia, notas só do playbook; vencidos de qualquer dia", async () => {
    const gestor = team.pessoas[0];
    const r = await buildDailyReport(db, { gestor, data: "2026-09-30", playbook: "spiced", barra: 60 });
    expect(r).toMatchObject({ calls: 3, analisadas: 2, nota_media: 60, abaixo_pct: 0.5, criticas: 1 });
    expect(r.etapa_mais_fraca).toEqual({ id: "impacto", falha_pct: 1, n: 2 });
    expect(r.top.map((t) => t.id)).toEqual(["c1"]);
    expect(r.top[0].motivo).toBe("Nenhuma etapa completa");
    expect(r.vencidos).toEqual([]); // "amanhã" = 01/10, ainda não venceu
    expect(r.sem_prazo).toBe(1);

    const depois = await buildDailyReport(db, { gestor, data: "2026-10-02", playbook: "spiced", barra: 60 });
    expect(depois.calls).toBe(0);
    expect(depois.vencidos.map((v) => [v.tarefa, v.venceu_em])).toEqual([["mandar proposta", "2026-10-01"]]);
    const n = dailyNotification(depois);
    expect(n.chave).toBe("diario:2026-10-02:spiced");
    expect(toText(n)).toContain("Nenhuma call comercial neste dia.");
    expect(toText(n)).toContain("mandar proposta (Ana Closer) — venceu 01/10");
  });
});
