import { describe, expect, it } from "vitest";
import { matchPerson } from "../src/core/config";
import {
  assignRoles,
  assignTimes,
  buildSegments,
  computeMetrics,
  countQuestions,
  findCallStart,
  isNoise,
} from "../src/core/normalize";
import { parseTxt } from "../src/core/parsers";
import type { Segment } from "../src/core/types";
import { rules, team, TXT_CALL } from "./fixtures";

describe("matchPerson", () => {
  it("casa nome completo, primeiro nome e ignora acento", () => {
    expect(matchPerson(team, "Ana Closer")?.id).toBe("ana");
    expect(matchPerson(team, "ANA Souza")?.id).toBe("ana");
    expect(matchPerson(team, "Biá")?.id).toBe("bia");
  });
  it("não casa alias curto como prefixo de outro nome", () => {
    expect(matchPerson(team, "Anastácia Lima")).toBeUndefined();
  });
});

describe("assignRoles", () => {
  const raw = parseTxt(TXT_CALL);
  it("closer pelo time, gente da Make por apresentação, resto cliente", () => {
    const r = assignRoles(raw, team);
    expect(r.closerId).toBe("ana");
    expect(r.roles).toEqual({ "Ana Closer": "closer", "Carlos Lead": "cliente", "Paula SDR": "outro" });
    expect(r.metodo["Paula SDR"]).toBe("heuristica");
  });
  it("papel do LLM vale para quem não é do time", () => {
    const r = assignRoles(raw, team, { llmRoles: { "Carlos Lead": "outro", "Ana Closer": "cliente" } });
    expect(r.roles["Ana Closer"]).toBe("closer");
    expect(r.roles["Carlos Lead"]).toBe("outro");
  });
  it("outra pessoa do time na call vira 'outro'", () => {
    const r = assignRoles([...raw, { speaker: "Bia Vendas", text: "oi" }], team);
    expect(r.roles["Bia Vendas"]).toBe("outro");
  });
});

describe("isNoise", () => {
  const cfg = rules.ingestao.ruido;
  it("detecta texto repetitivo de ASR", () => {
    expect(isNoise("onde você está andando não não é isso ".repeat(8), cfg)).toBe(true);
  });
  it("não marca fala normal nem fala curta", () => {
    const normal =
      "A gente começou a empresa em dois mil e dezoito com três pessoas e hoje somos quarenta no time comercial e de operações atendendo o Brasil inteiro com foco em clínicas";
    expect(isNoise(normal, cfg)).toBe(false);
    expect(isNoise("não não não não", cfg)).toBe(false);
  });
});

describe("findCallStart", () => {
  const seg = (speaker: string, role: Segment["role"], text: string) => ({ speaker, role, text });
  it("começa no cumprimento ao lead, deixando conversa interna como bastidor", () => {
    const segs = [
      seg("Ana", "closer", "Vou ligar pro outro cliente depois"),
      seg("Ana", "closer", "Fala Carlos, boa tarde!"),
      seg("Carlos", "cliente", "Boa tarde"),
    ];
    expect(findCallStart(segs)).toBe(1);
  });
  it("sem cliente, começa em 0", () => {
    expect(findCallStart([seg("Ana", "closer", "teste")])).toBe(0);
  });
});

describe("assignTimes", () => {
  it("usa timestamps do arquivo quando existem", () => {
    const r = assignTimes([{ speaker: "a", text: "x y", start: 1, end: 2 }], { wpm: 150 });
    expect(r).toEqual({ times: [{ start: 1, end: 2 }], estimado: false });
  });
  it("sem timestamps distribui a duração do vídeo por palavras", () => {
    const r = assignTimes(
      [{ speaker: "a", text: "um dois" }, { speaker: "b", text: "um dois tres quatro cinco seis" }],
      { wpm: 150, durationSec: 120 },
    );
    expect(r.estimado).toBe(true);
    expect(r.times[0]).toEqual({ start: 0, end: 40 }); // (2+2)/(4+8) * 120
    expect(r.times[1].end).toBe(120);
  });
  it("sem vídeo estima por palavras/minuto", () => {
    const r = assignTimes([{ speaker: "a", text: Array(148).fill("p").join(" ") }], { wpm: 150 });
    expect(r.times[0].end).toBe(60);
  });
});

describe("countQuestions", () => {
  it("conta perguntas pela interrogação", () => {
    expect(countQuestions("Tudo bem? Como vocês captam cliente?? Legal.")).toBe(2);
  });
});

describe("computeMetrics", () => {
  const s = (idx: number, role: Segment["role"], start: number, end: number, text: string, flags?: Segment["flags"]): Segment => ({
    idx, speaker: role, role, start, end, text, flags,
  });
  const segs = [
    s(0, "closer", 0, 30, "conversa interna", ["bastidor"]),
    s(1, "closer", 30, 90, "Oi, tudo bem? Me conta do negócio?"),
    s(2, "cliente", 90, 92, "aham"),
    s(3, "closer", 92, 150, "continua explicando"),
    s(4, "cliente", 150, 210, "Temos três lojas e faturamos bem. E o preço?"),
    s(5, "outro", 210, 240, "complemento da especialista"),
  ];
  const m = computeMetrics(segs, true);

  it("ignora bastidor no % de fala e na duração efetiva", () => {
    expect(m.duracao_total_seg).toBe(240);
    expect(m.duracao_efetiva_seg).toBe(210);
    expect(m.fala_pct.closer).toBeCloseTo(118 / 210);
    expect(m.fala_pct.cliente).toBeCloseTo(62 / 210);
    expect(m.fala_pct.outro).toBeCloseTo(30 / 210);
  });
  it("monólogo não é interrompido por interjeição curta do cliente", () => {
    expect(m.maior_monologo_closer_seg).toBe(118);
  });
  it("conta perguntas por papel", () => {
    expect(m.perguntas).toEqual({ closer: 2, cliente: 1 });
    expect(m.segmentos_bastidor).toBe(1);
  });
});

describe("buildSegments", () => {
  it("marca bastidor e aplica papéis e tempos", () => {
    const raw = parseTxt(TXT_CALL);
    const { roles } = assignRoles(raw, team);
    const { segments, startIdx, estimado } = buildSegments(raw, roles, { durationSec: 600, rules });
    expect(estimado).toBe(true);
    expect(startIdx).toBe(1);
    expect(segments[0].flags).toEqual(["bastidor"]);
    expect(segments.at(-1)!.end).toBe(600);
    expect(segments.every((x, i) => x.idx === i)).toBe(true);
  });
});
