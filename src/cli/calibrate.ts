/**
 * pnpm calibrate --template [--playbook <id>]     gera data/calibracao.template.csv para preencher
 * pnpm calibrate [--file data/calibracao.csv]     importa a avaliação humana e gera o relatório
 * pnpm calibrate --estabilidade [--calls a,b] [--playbook <id>] [--rodadas 2] [--yes]
 *                                                 reanalisa calls sem tocar na análise oficial (consome cota)
 * Relatório em out/calibracao/relatorio-<data>.md.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq, isNotNull } from "drizzle-orm";
import {
  calibrationTemplate, compareCalibration, estimateStability, parseCsv, parseLabels, renderCalibrationReport, runStability, saveLabels, stabilityReport,
} from "../core/calibration";
import { openDb } from "../core/db/client";
import { analyses, calibration_labels, stability_runs } from "../core/db/schema";
import { usdBrl } from "../core/llm/pricing";
import { getProvider, llmAvailable } from "../core/llm/provider";
import { isActive, loadPlaybooks } from "../core/playbook";
import { mostAnalyzedPlaybook } from "../core/queries";
import { recompute } from "../core/analysis/score";
import { loadConfig } from "../core/config";
import { flag, loadEnv, option, pct } from "./_shared";

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const db = await openDb();
  const all = loadPlaybooks().filter(isActive);
  const wanted = option(args, "playbook");
  const playbooks = all.filter((p) => !wanted || p.id === wanted);
  if (!playbooks.length) throw new Error(`Playbook ${wanted} não existe ou não está ativo`);
  const stageName = (pb: string, id: string) => all.find((p) => p.id === pb)?.etapas.find((e) => e.id === id)?.nome ?? id;
  const hoje = new Date().toLocaleDateString("sv-SE");

  if (flag(args, "template")) {
    const out = "data/calibracao.template.csv";
    fs.writeFileSync(out, await calibrationTemplate(db, playbooks));
    console.log(`Template em ${out}.`);
    console.log("Preencha a coluna `avaliacao` (completo | parcial | ausente; na linha risco_de_churn: sim | nao) e salve como data/calibracao.csv.");
    console.log("A resposta da IA não aparece no template de propósito, para não influenciar a sua avaliação. Pode deixar linhas em branco.");
    return;
  }

  if (flag(args, "estabilidade")) {
    if (!llmAvailable()) throw new Error("LLM indisponível (veja README: Motor de IA)");
    const pbId = wanted ?? (await mostAnalyzedPlaybook(db, all.map((x) => x.id)));
    const pb = all.find((p) => p.id === pbId)!;
    const rodadas = Number(option(args, "rodadas") ?? 2);
    const pedidas = option(args, "calls")?.split(",").map((s) => s.trim()).filter(Boolean);
    const analisadas = await db.select({ id: analyses.call_id }).from(analyses).where(and(eq(analyses.playbook_id, pb.id), isNotNull(analyses.nota_aderencia)));
    const callIds = pedidas ?? [...new Set(analisadas.map((a) => a.id))].sort().slice(0, 5);
    if (!callIds.length) throw new Error(`Nenhuma call analisada no playbook ${pb.id}`);
    const usd = await estimateStability(db, callIds, pb, rodadas);
    const assinatura = getProvider().name === "claude-cli";
    console.log(`Estabilidade: ${callIds.length} call(s) × ${rodadas} rodada(s) no playbook ${pb.id} = ${callIds.length * rodadas} análises`);
    console.log(`Estimativa: ~US$ ${usd.toFixed(2)} / ~R$ ${(usd * usdBrl()).toFixed(2)}${assinatura ? " (equivalente; consome a cota da assinatura)" : ""}`);
    console.log(`Calls: ${callIds.join(", ")}`);
    if (!flag(args, "yes")) {
      console.log("Confirme com --yes.");
      process.exit(1);
    }
    const anteriores = await db.select().from(stability_runs).where(eq(stability_runs.playbook_id, pb.id));
    for (const id of callIds)
      for (let i = 0; i < rodadas; i++) {
        const rodada = anteriores.filter((r) => r.call_id === id).length + i + 1;
        process.stdout.write(`${id} rodada ${rodada}… `);
        try {
          const r = await runStability(db, id, pb, rodada);
          console.log(`nota ${Math.round(r.nota)} · US$ ${r.usd.toFixed(3)}`);
        } catch (e) {
          console.log(`ERRO: ${(e as Error).message}`);
        }
      }
  }

  // Importa o CSV (se houver) e gera o relatório
  const file = option(args, "file") ?? "data/calibracao.csv";
  let erros: string[] = [];
  if (fs.existsSync(file)) {
    const parsed = parseLabels(parseCsv(fs.readFileSync(file, "utf8")));
    erros = parsed.erros;
    const { salvas, desconhecidas } = await saveLabels(db, parsed.labels);
    if (desconhecidas.length) erros.push(`call_id inexistente (ignorado): ${desconhecidas.join(", ")}`);
    // A sua avaliação resolve as etapas em revisão: recalcula nota, selo e classificação dessas calls.
    const cfg = loadConfig();
    const tocadas = new Set(parsed.labels.map((l) => `${l.call_id}|${l.playbook_id}`));
    const doBanco = await db.select({ id: analyses.id, call: analyses.call_id, playbook: analyses.playbook_id }).from(analyses);
    let recalculadas = 0;
    for (const a of doBanco.filter((x) => tocadas.has(`${x.call}|${x.playbook}`))) {
      const pb = all.find((p) => p.id === a.playbook);
      if (!pb) continue;
      await recompute(db, cfg, a.id, pb);
      recalculadas++;
    }
    if (recalculadas) console.log(`${recalculadas} análise(s) com nota recalculada pela sua avaliação.`);
    console.log(`${salvas} avaliação(ões) importada(s) de ${file}${erros.length ? ` · ${erros.length} aviso(s)` : ""}.`);
  } else if (!flag(args, "estabilidade")) {
    const ja = await db.select({ id: calibration_labels.id }).from(calibration_labels).limit(1);
    if (!ja.length) console.log(`Sem ${file}. Gere o template com: pnpm calibrate --template`);
  }

  const results = [];
  for (const pb of playbooks) results.push(await compareCalibration(db, pb.id));
  const md = renderCalibrationReport(results, await stabilityReport(db), { data: hoje, stageName, erros });
  fs.mkdirSync("out/calibracao", { recursive: true });
  const out = path.join("out/calibracao", `relatorio-${hoje}.md`);
  fs.writeFileSync(out, md);

  for (const r of results.filter((x) => x.geral.n || x.churn.n))
    console.log(`${r.playbook_id}: ${r.calls} call(s) · concordância ${pct(r.geral.exata)} (completo vs. não ${pct(r.geral.binaria)}) · kappa ${r.geral.kappa?.toFixed(2) ?? "—"} · churn ${r.churn.concordancia == null ? "—" : pct(r.churn.concordancia)}`);
  for (const e of erros) console.log(`  ! ${e}`);
  console.log(`Relatório: ${out}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
