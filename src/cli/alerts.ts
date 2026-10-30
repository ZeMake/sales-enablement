/**
 * pnpm alerts [--call <id>]
 * Gera os alertas (crítica / churn vermelho) das análises já salvas. O `pnpm analyze` já faz isso
 * sozinho ao terminar cada análise; este comando serve para análises antigas. Não repete alerta
 * que já foi gerado (um por call × gestor).
 */
import { eq } from "drizzle-orm";
import { loadConfig } from "../core/config";
import { openDb } from "../core/db/client";
import { analyses } from "../core/db/schema";
import { alertAnalysis } from "../core/notify/alerts";
import { dryRun } from "../core/notify/index";
import { loadEnv, option } from "./_shared";

async function main() {
  loadEnv();
  const cfg = loadConfig();
  const db = await openDb();
  const callId = option(process.argv.slice(2), "call");
  const rows = await db.select({ id: analyses.id }).from(analyses).where(callId ? eq(analyses.call_id, callId) : undefined).orderBy(analyses.created_at);
  if (!rows.length) throw new Error(callId ? `Nenhuma análise da call ${callId}` : "Nenhuma análise salva");

  let novos = 0;
  for (const r of rows)
    for (const al of await alertAnalysis(db, cfg, r.id)) {
      const gerados = al.results.filter((x) => x.status !== "duplicada");
      if (!gerados.length) continue;
      novos++;
      console.log(`${r.id} → ${al.destinatario}: ${gerados.map((x) => `${x.canal} ${x.status}${x.erro ? ` (${x.erro})` : ""}`).join(", ")}`);
    }
  console.log(`\n${novos} alerta(s) novo(s)${dryRun() ? " (dry-run: veja out/notifications/ e a central no painel)" : ""}.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
