import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "../src/core/db/client";
import { calls, segments } from "../src/core/db/schema";
import { ingestCall, syncPeople } from "../src/core/ingest";
import { parseManifest, parseMoney, toManifestCsv } from "../src/core/sources/manifest";
import { inferFromFilename, LocalFolderSource } from "../src/core/sources/local-folder";
import { rules, team, TXT_CALL } from "./fixtures";

const cfg = { team, rules };

describe("manifest", () => {
  it("lê CSV com aspas, ponto e vírgula e valor em reais", () => {
    const csv = 'call_id;desfecho;valor_venda;obs\nc1;ganho;"R$ 12.500,00";"disse ""sim"""\nc2;talvez;;\n';
    const { rows, errors } = parseManifest(csv);
    expect(rows).toEqual([{ call_id: "c1", desfecho: "ganho", valor_venda: 12500, obs: 'disse "sim"', transcricao: undefined, video: undefined }]);
    expect(errors[0]).toMatch(/linha 3: desfecho/);
  });
  it("gera CSV que volta igual", () => {
    const rows = [{ call_id: "c1", obs: "a, b", desfecho: "perdido" as const }];
    expect(parseManifest(toManifestCsv(rows)).rows[0]).toMatchObject(rows[0]);
  });
  it("parseMoney aceita formato US", () => {
    expect(parseMoney("1500.5")).toBe(1500.5);
  });
});

describe("inferFromFilename", () => {
  it("tira call_id e closer do nome do arquivo", () => {
    expect(inferFromFilename("Reunião-07-Bia", team)).toEqual({ call_id: "reuniao-07-bia", closer: "bia", data_hora: undefined });
    expect(inferFromFilename("2026-09-01_Ana_cliente", team).data_hora).toBe("2026-09-01");
  });
});

describe("ingestCall (sem LLM)", () => {
  let dir: string;
  let db: Db;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-test-"));
    fs.mkdirSync(path.join(dir, "inbox"));
    db = await openDb(path.join(dir, "test.db"));
    await syncPeople(db, cfg);
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const longCall = TXT_CALL + "\n" + Array.from({ length: 80 }, (_, i) => `Carlos Lead: resposta número ${i} sobre o negócio com detalhes suficientes para somar duração`).join("\n\n");
  const opts = () => ({ llm: false, processedDir: path.join(dir, "processed"), mediaDir: path.join(dir, "media") });
  const listAll = async () => {
    const src = new LocalFolderSource(path.join(dir, "inbox"), team);
    return { src, list: (await src.list()).calls };
  };

  it("ingere, é idempotente por hash e detecta duplicata", async () => {
    fs.writeFileSync(path.join(dir, "inbox", "Reuniao-01-Ana.txt"), longCall);
    fs.writeFileSync(path.join(dir, "inbox", "Reuniao-02-Ana.txt"), longCall);
    let { src, list } = await listAll();
    const r1 = await ingestCall(db, cfg, src, list[0], opts());
    expect(r1.acao).toBe("ingerida");
    expect(r1.closer).toBe("ana");
    expect(r1.triage?.metodo).toBe("heuristica");
    const r2 = await ingestCall(db, cfg, src, list[1], opts());
    expect(r2).toMatchObject({ acao: "ignorada", motivo: expect.stringContaining("duplicata de reuniao-01-ana") });

    ({ src, list } = await listAll());
    expect((await ingestCall(db, cfg, src, list[0], opts())).acao).toBe("ignorada");
    expect((await db.select().from(segments).where(eq(segments.call_id, "reuniao-01-ana")).all()).length).toBeGreaterThan(40);
    expect(fs.existsSync(path.join(dir, "processed", "reuniao-01-ana.json"))).toBe(true);
  });

  it("manifest atualiza desfecho sem reprocessar e sem apagar campos", async () => {
    fs.writeFileSync(path.join(dir, "inbox", "Reuniao-01-Ana.txt"), longCall);
    let { src, list } = await listAll();
    await ingestCall(db, cfg, src, list[0], opts());
    await db.update(calls).set({ produto: "Make ADS" }).where(eq(calls.id, "reuniao-01-ana")); // edição no painel
    const before = (await db.select().from(calls).get())!;

    fs.writeFileSync(path.join(dir, "inbox", "manifest.csv"), "call_id,transcricao,desfecho\nreuniao-01-ana,Reuniao-01-Ana.txt,ganho\n");
    ({ src, list } = await listAll());
    expect((await ingestCall(db, cfg, src, list[0], opts())).acao).toBe("meta_atualizada");
    const after = (await db.select().from(calls).get())!;
    expect(after.desfecho).toBe("ganho");
    expect(after.produto).toBe("Make ADS");
    expect(after.ingested_at).toBe(before.ingested_at);
  });

  it("call curta vira nao_comercial pela regra", async () => {
    fs.writeFileSync(path.join(dir, "inbox", "Reuniao-03-Ana.txt"), TXT_CALL);
    const { src, list } = await listAll();
    const r = await ingestCall(db, cfg, src, list[0], opts());
    expect(r.triage).toMatchObject({ status: "nao_comercial", metodo: "regra" });
  });

  it("ignora call sem transcrição", async () => {
    fs.writeFileSync(path.join(dir, "inbox", "Reuniao-04-Ana.webm"), "fake");
    const { src, list } = await listAll();
    expect((await ingestCall(db, cfg, src, list[0], opts())).motivo).toMatch(/sem transcrição/);
  });
});
