/**
 * pnpm db:push [--force]
 * Copia o banco local (data/app.db) para o banco hospedado (Turso) da versão publicada: calls,
 * transcrições, análises, notas, segunda opinião, custos. Lê a URL e o token de .env.vercel
 * (`npx vercel env pull .env.vercel --environment production`). --force apaga o que já existir lá.
 */
import { getTableName } from "drizzle-orm";
import { openDb } from "../core/db/client";
import * as t from "../core/db/schema";
import { flag, lerEnvVercel, loadEnv } from "./_shared";

// Ordem das chaves estrangeiras: pais antes dos filhos.
const TABELAS = [t.people, t.calls, t.segments, t.analyses, t.stage_results, t.evidences, t.objections, t.churn_flags, t.next_steps, t.notifications, t.cost_log, t.calibration_labels, t.stability_runs, t.reliability, t.jobs];

async function main() {
  loadEnv();
  const alvo = lerEnvVercel();
  const local = await openDb(process.env.DATABASE_PATH ?? "data/app.db", { url: undefined });
  const remoto = await openDb(undefined, alvo); // aplica as migrações lá
  const jaTem = await remoto.select().from(t.calls).limit(1);
  if (jaTem.length && !flag(process.argv.slice(2), "force")) throw new Error("O banco hospedado já tem dados. Use --force para substituir.");
  for (const tab of [...TABELAS].reverse()) await remoto.delete(tab);
  for (const tab of TABELAS) {
    const rows = await local.select().from(tab);
    for (let i = 0; i < rows.length; i += 200) await remoto.insert(tab).values(rows.slice(i, i + 200) as never);
    console.log(`${getTableName(tab).padEnd(20)} ${rows.length}`);
  }
  console.log("\nBanco copiado para o Turso.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
