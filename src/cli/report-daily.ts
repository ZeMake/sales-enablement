/**
 * pnpm report:daily [--date YYYY-MM-DD] [--gestor <id>] [--playbook <id>] [--force]
 * Gera o relatório diário de cada gestor e despacha pelos canais (dry-run por padrão:
 * out/notifications/<data>/ + central do painel). --force gera de novo o relatório daquele dia.
 */
import { loadConfig } from "../core/config";
import { openDb } from "../core/db/client";
import { dispatch, dryRun, toText } from "../core/notify/index";
import { isActive, loadPlaybooks } from "../core/playbook";
import { mostAnalyzedPlaybook } from "../core/queries";
import { buildDailyReport, dailyNotification } from "../core/report/daily";
import { flag, loadEnv, option } from "./_shared";

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const db = await openDb();
  const data = option(args, "date") ?? new Date().toLocaleDateString("sv-SE");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(data)) throw new Error("--date precisa ser YYYY-MM-DD");

  const playbooks = loadPlaybooks().filter(isActive);
  const playbook = option(args, "playbook") ?? (await mostAnalyzedPlaybook(db, playbooks.map((p) => p.id)));
  const pb = playbooks.find((p) => p.id === playbook);
  if (!pb) throw new Error(`Playbook ${playbook} não existe ou não está ativo`);
  const stageName = (id: string) => pb.etapas.find((e) => e.id === id)?.nome ?? id;

  const wanted = option(args, "gestor");
  const gestores = cfg.team.pessoas.filter((p) => p.papeis.includes("gestor") && (!wanted || p.id === wanted));
  if (!gestores.length) throw new Error(wanted ? `Gestor ${wanted} não existe em team.yaml` : "Nenhum gestor em team.yaml");

  console.log(`Relatório diário de ${data} · playbook ${pb.nome}${dryRun() ? " · DRY-RUN (nada sai para Slack/WhatsApp)" : ""}\n`);
  for (const g of gestores) {
    const r = await buildDailyReport(db, { gestor: g, data, playbook, barra: cfg.rules.classificacao.barra_minima_aderencia });
    const n = dailyNotification(r, stageName);
    const res = await dispatch(db, n, { replace: flag(args, "force") });
    console.log("─".repeat(72));
    console.log(toText(n));
    console.log(`\n↳ ${res.map((x) => `${x.canal}: ${x.status}${x.erro ? ` (${x.erro})` : ""}`).join(" · ")}`);
    if (res.some((x) => x.status === "duplicada")) console.log("  (já gerado para este dia; use --force para gerar de novo)");
    const arquivos = res.map((x) => x.arquivo).filter(Boolean);
    if (arquivos.length) console.log(`  arquivos: ${arquivos.join(", ")}`);
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
