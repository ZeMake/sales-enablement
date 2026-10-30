import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { adicionadasHoje, destravar, enqueue, proximoJob, travar } from "../src/core/jobs";
import { jobs } from "../src/core/db/schema";
import { tempDb } from "./seed";

describe("fila de calls", () => {
  let ctx: Awaited<ReturnType<typeof tempDb>>;
  beforeEach(async () => {
    ctx = await tempDb();
  });
  afterEach(() => ctx.cleanup());

  it("trava: só um passo por vez na mesma call (sem análise em dobro)", async () => {
    const id = await enqueue(ctx.db, { transcriptUrl: "https://x/a.txt" });
    expect(await travar(ctx.db, id)).toBe(true);
    expect(await travar(ctx.db, id)).toBe(false); // outra chamada simultânea desiste
    await destravar(ctx.db, id);
    expect(await travar(ctx.db, id)).toBe(true);
    expect(await travar(ctx.db, id, -1)).toBe(false);
  });

  it("trava vencida pode ser retomada (passo que caiu no meio)", async () => {
    const id = await enqueue(ctx.db, { transcriptText: "x".repeat(300) });
    expect(await travar(ctx.db, id, -1000)).toBe(true); // trava já vencida
    expect(await travar(ctx.db, id)).toBe(true);
  });

  it("próximo job: retoma o que está rodando antes de pegar novo da fila", async () => {
    const a = await enqueue(ctx.db, { transcriptUrl: "https://x/a.txt" });
    const b = await enqueue(ctx.db, { transcriptUrl: "https://x/b.txt" });
    expect((await proximoJob(ctx.db))?.id).toBe(a);
    const { eq } = await import("drizzle-orm");
    await ctx.db.update(jobs).set({ status: "rodando" }).where(eq(jobs.id, b));
    expect((await proximoJob(ctx.db))?.id).toBe(b);
  });

  it("conta as adicionadas hoje (limite diário)", async () => {
    await enqueue(ctx.db, { transcriptUrl: "https://x/a.txt" });
    await enqueue(ctx.db, { transcriptUrl: "https://x/b.txt" });
    await ctx.db.insert(jobs).values({ status: "concluida", created_at: "2020-01-01T12:00:00.000Z", updated_at: "2020-01-01T12:00:00.000Z" });
    expect(await adicionadasHoje(ctx.db)).toBe(2);
  });
});
