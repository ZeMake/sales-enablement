import { describe, expect, it } from "vitest";
import { parseCues, parseJson, parseTranscript, parseTxt } from "../src/core/parsers";
import { SRT_CALL, TXT_CALL, VTT_CALL } from "./fixtures";

describe("parseTxt", () => {
  it("separa falas por falante e junta linhas de continuação", () => {
    const segs = parseTxt(TXT_CALL);
    expect(segs).toHaveLength(8);
    expect(segs[3]).toEqual({
      speaker: "Carlos Lead",
      text: "Hoje é tudo indicação. A gente fatura uns 80 mil por mês e quer chegar em 150 mil até dezembro.",
    });
  });

  it("aceita nome de empresa como falante e ignora BOM e CRLF", () => {
    const segs = parseTxt("﻿Acme! Telas digitais: Bom dia\r\n\r\nAna: Oi\r\n");
    expect(segs.map((s) => s.speaker)).toEqual(["Acme! Telas digitais", "Ana"]);
  });

  it("não trata horário no início da linha como falante", () => {
    const segs = parseTxt("Ana: vamos marcar\nàs 10:30 então");
    expect(segs).toHaveLength(1);
    expect(segs[0].text).toBe("vamos marcar às 10:30 então");
  });

  it("texto sem falante vira 'desconhecido'", () => {
    expect(parseTxt("só texto solto")[0].speaker).toBe("desconhecido");
  });
});

describe("parseCues", () => {
  it("lê .vtt com <v Nome> e junta cues seguidos do mesmo falante", () => {
    const segs = parseCues(VTT_CALL);
    expect(segs).toHaveLength(2);
    expect(segs[0]).toMatchObject({ speaker: "Ana Closer", start: 1, end: 6 });
    expect(segs[0].text).toBe("Bom dia, tudo bem? Pode me contar do seu negócio?");
    expect(segs[1]).toMatchObject({ speaker: "Carlos Lead", start: 6.2, end: 12 });
  });

  it("lê .srt com 'Nome: fala' e vírgula nos milissegundos", () => {
    const segs = parseCues(SRT_CALL);
    expect(segs[1]).toMatchObject({ speaker: "Carlos Lead", start: 3.5, end: 8.25 });
    expect(segs[1].text).toContain("10:30");
  });
});

describe("parseJson", () => {
  it("aceita { segments: [...] } com nomes de campo variados e ms", () => {
    const segs = parseJson(
      JSON.stringify({ segments: [{ name: "Ana", content: "Oi", start_time: 1500000, end_time: 2500000 }, { speaker: "Carlos", text: " " }] }),
    );
    expect(segs).toEqual([{ speaker: "Ana", text: "Oi", start: 1500, end: 2500 }]);
  });

  it("falha claramente sem lista de falas", () => {
    expect(() => parseJson('{"foo": 1}')).toThrow(/lista de falas/);
  });
});

describe("parseTranscript", () => {
  it("escolhe o parser pela extensão", () => {
    expect(parseTranscript("a.vtt", VTT_CALL)[0].start).toBe(1);
    expect(() => parseTranscript("a.docx", "")).toThrow(/não suportado/);
  });
});

describe("parseTxt com horários do CRM", () => {
  it("casa os horários por linha, inclusive linhas sem nome que continuam a fala", () => {
    const txt = "Ana: Oi.\ncontinua aqui\n\nJoão: Tudo bem?";
    const segs = parseTxt(txt, [{ start: 10, end: 11 }, { start: 11, end: 14 }, { start: 15, end: 16 }]);
    expect(segs).toEqual([
      { speaker: "Ana", text: "Oi. continua aqui", start: 10, end: 14 },
      { speaker: "João", text: "Tudo bem?", start: 15, end: 16 },
    ]);
  });
  it("ignora os horários se a contagem não bater", () => {
    expect(parseTxt("Ana: Oi.", [{ start: 1, end: 2 }, { start: 3, end: 4 }])[0].start).toBeUndefined();
  });
});
