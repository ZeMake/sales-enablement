import { describe, expect, it } from "vitest";
import { acharVideoAoLado, callIdDoLink, tituloDoLink, UrlSource } from "../src/core/sources/url";
import { team } from "./fixtures";

const BASE = "https://storage.googleapis.com/makecrm_meet/936de2e7-acbf-4389-b923-fd6e51e44129/4e7470a3-b895-4aec-8ae8-30ed20a44780/Reuni%C3%A3o%20com%20Ana";
const TXT = `${BASE}.txt`;

/** fetch falso: só responde o que estiver no mapa (sintético, sem rede). */
const fakeFetch = (rotas: Record<string, string | number>) =>
  (async (url: string | URL, init?: RequestInit) => {
    const r = rotas[String(url)];
    if (r === undefined || typeof r === "number") return new Response(null, { status: typeof r === "number" ? r : 404 });
    return new Response(init?.method === "HEAD" ? null : r, { status: 200 });
  }) as typeof fetch;

describe("origem por link (CRM)", () => {
  it("título e id a partir do link", () => {
    expect(tituloDoLink(TXT)).toBe("Reunião com Ana");
    expect(callIdDoLink(TXT)).toBe("crm-4e7470a3");
  });

  it("acha o vídeo ao lado da transcrição", async () => {
    expect(await acharVideoAoLado(TXT, fakeFetch({ [`${BASE}.webm`]: "" }))).toBe(`${BASE}.webm`);
    expect(await acharVideoAoLado(TXT, fakeFetch({}))).toBeUndefined();
  });

  it("lê a transcrição pelo link, sem disco, e avisa quando não há vídeo", async () => {
    const src = new UrlSource([{ transcriptUrl: TXT }], team, fakeFetch({ [TXT]: "Ana Closer: Oi\n\nCarlos Lead: Olá" }));
    const { calls, warnings } = await src.list();
    expect(calls[0]).toMatchObject({ call_id: "crm-4e7470a3", transcriptPath: TXT, videoPath: undefined, meta: { obs: "Reunião com Ana" } });
    expect(warnings[0]).toContain("sem vídeo");
    expect(await src.readTranscript(calls[0])).toContain("Carlos Lead");
  });

  it("transcrição colada: sem arquivo, id pelo vídeo ou pelo próprio texto", async () => {
    const texto = "Ana Closer: Oi\n\nCarlos Lead: Olá";
    const src = new UrlSource([{ transcriptText: texto, videoUrl: `${BASE}.webm` }, { transcriptText: texto + "!" }], team, fakeFetch({}));
    const { calls } = await src.list();
    expect(calls[0]).toMatchObject({ call_id: "crm-4e7470a3", videoPath: `${BASE}.webm`, meta: { obs: "Reunião com Ana" } });
    expect(calls[1].call_id).toMatch(/^colada-[0-9a-f]{8}$/);
    expect(await src.readTranscript(calls[1])).toContain("Olá!");
  });

  it("transcrição fora do ar dá erro claro", async () => {
    const src = new UrlSource([{ transcriptUrl: TXT }], team, fakeFetch({ [TXT]: 403 }));
    await expect(src.list()).rejects.toThrow("Transcrição indisponível (403)");
  });
});
