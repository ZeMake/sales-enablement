/**
 * pnpm jobs
 * Roda a fila de calls adicionadas pelo painel (o botão "Adicionar call" dispara isto sozinho).
 * Se já houver uma fila rodando, sai sem fazer nada.
 */
import { loadConfig } from "../core/config";
import { openDb } from "../core/db/client";
import { filaAtiva, runQueue } from "../core/jobs";
import { loadEnv } from "./_shared";

async function main() {
  loadEnv();
  const db = await openDb();
  if (await filaAtiva(db)) return console.log("Fila já está rodando.");
  const n = await runQueue(db, loadConfig());
  console.log(`${n} call(s) processada(s).`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
