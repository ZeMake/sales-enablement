/**
 * pnpm reclassify [--dry-run]
 * Recalcula nota (pelo status das etapas), faixa, selo de validação e classificação (ok / atenção /
 * crítica) de todas as análises salvas, com as regras atuais do config/rules.yaml, o segundo
 * julgamento do Jev e a revisão humana da calibração. Não chama IA: custo zero.
 * --dry-run só mostra o que mudaria.
 */
import { recompute } from "../core/analysis/score";
import { loadConfig } from "../core/config";
import { openDb } from "../core/db/client";
import { analyses } from "../core/db/schema";
import { loadPlaybooks } from "../core/playbook";
import { flag, loadEnv, table } from "./_shared";

const SELO: Record<string, string> = { validada: "validada", provisoria: "provisória", sem_jev: "sem Jev" };

async function main() {
  loadEnv();
  const dryRun = flag(process.argv.slice(2), "dry-run");
  const cfg = loadConfig();
  const db = await openDb();
  const playbooks = loadPlaybooks();
  const rows = await db.select({ id: analyses.id, call: analyses.call_id, playbook: analyses.playbook_id, nota: analyses.nota_aderencia, antes: analyses.classificacao }).from(analyses).orderBy(analyses.playbook_id, analyses.call_id);
  if (!rows.length) {
    console.log("Nenhuma análise salva.");
    return;
  }

  const out: string[][] = [];
  const motivos: string[] = [];
  for (const r of rows) {
    const pb = playbooks.find((p) => p.id === r.playbook);
    if (!pb) continue;
    const n = await recompute(db, cfg, r.id, pb, { dryRun });
    const faixa = n.nota_min !== n.nota_max ? `${Math.round(n.nota_min)}–${Math.round(n.nota_max)}` : "";
    out.push([r.call, r.playbook, String(Math.round(r.nota ?? 0)), String(Math.round(n.nota)), faixa, SELO[n.validacao], r.antes ?? "—", n.classificacao, r.antes === n.classificacao ? "" : "mudou"]);
    if (n.motivos.length) motivos.push(`\n${r.call} × ${r.playbook} (${n.classificacao}):\n  - ${n.motivos.join("\n  - ")}`);
  }
  console.log(table(["call", "playbook", "nota antes", "nota", "faixa", "selo", "antes", "agora", ""], out));
  for (const m of motivos) console.log(m);
  console.log(dryRun ? "\n--dry-run: nada foi gravado." : `\n${out.length} análise(s) recalculada(s), sem chamar IA.`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
