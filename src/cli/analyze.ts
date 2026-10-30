/**
 * pnpm analyze --call <id> | --all [--playbook <id>] [--force] [--yes] [--publicado]
 * Analisa calls comerciais em cada playbook ativo. Não reanalisa o que já existe (mesma
 * call × playbook × versão do prompt) sem --force.
 */
import { eq } from "drizzle-orm";
import { analysisId, analyzeCall, buildSystemPrompt, buildUserPrompt, estimateAnalysis, loadSegments, type AnalyzeResult } from "../core/analysis/run";
import { loadConfig } from "../core/config";
import { analyses, calls } from "../core/db/schema";
import { analysisModel } from "../core/llm/client";
import { usdBrl } from "../core/llm/pricing";
import { getProvider, llmAvailable } from "../core/llm/provider";
import { alertAnalysis } from "../core/notify/alerts";
import { isActive, loadPlaybooks } from "../core/playbook";
import { abrirBanco, flag, loadEnv, option, table } from "./_shared";

const CONFIRM_ABOVE = 3;
const STATUS_ICON: Record<string, string> = { completo: "●", parcial: "◐", ausente: "○" };

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const db = await abrirBanco(args);
  if (!llmAvailable()) throw new Error("LLM indisponível: instale/atualize o Claude Code (LLM_PROVIDER=claude-cli) ou configure a API.");

  const all = loadPlaybooks();
  const wanted = option(args, "playbook");
  const playbooks = all.filter((p) => (wanted ? p.id === wanted : isActive(p)));
  if (wanted && !playbooks.length) throw new Error(`Playbook ${wanted} não existe`);
  const skipped = all.filter((p) => !isActive(p) && !wanted).map((p) => p.id);
  if (skipped.length) console.log(`Playbooks ignorados (status TODO): ${skipped.join(", ")}`);
  for (const p of playbooks) if (!isActive(p)) throw new Error(`Playbook ${p.id} ainda está como TODO`);

  const callId = option(args, "call");
  if (!callId && !flag(args, "all")) throw new Error("Use --call <id> ou --all");
  const rows = callId
    ? await db.select().from(calls).where(eq(calls.id, callId)).all()
    : await db.select().from(calls).where(eq(calls.triage_status, "comercial")).all();
  if (!rows.length) throw new Error(callId ? `Call ${callId} não encontrada` : "Nenhuma call comercial ingerida");

  const force = flag(args, "force");
  const jobs: Array<{ call: (typeof rows)[number]; playbook: (typeof playbooks)[number] }> = [];
  for (const call of rows)
    for (const playbook of playbooks) {
      const exists = await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.id, analysisId(call.id, playbook.id))).get();
      if (exists && !force) console.log(`• ${call.id} × ${playbook.id}: já analisada (use --force para refazer)`);
      else jobs.push({ call, playbook });
    }
  if (!jobs.length) return;

  // Estimativa antes de gastar
  const model = analysisModel();
  let tokIn = 0, tokOut = 0, usd = 0;
  for (const j of jobs) {
    const e = estimateAnalysis(buildSystemPrompt(j.playbook), buildUserPrompt(j.call, await loadSegments(db, j.call.id), j.playbook.id), model);
    tokIn += e.input; tokOut += e.output; usd += e.usd;
  }
  const assinatura = getProvider().name === "claude-cli";
  console.log(
    `Estimativa: ${jobs.length} análise(s), ~${Math.round(tokIn / 1000)}k tokens de entrada + ~${Math.round(tokOut / 1000)}k de saída, ` +
      `~US$ ${usd.toFixed(2)} / ~R$ ${(usd * usdBrl()).toFixed(2)} (${model})` +
      (assinatura ? "\n  → via Claude Code: consome a sua assinatura; o valor acima é só o equivalente em API." : ""),
  );
  if (jobs.length > CONFIRM_ABOVE && !flag(args, "yes")) {
    console.log(`Mais de ${CONFIRM_ABOVE} análises: confirme rodando com --yes.`);
    process.exit(1);
  }

  const results: AnalyzeResult[] = [];
  for (const [i, j] of jobs.entries()) {
    process.stdout.write(`[${i + 1}/${jobs.length}] ${j.call.id} × ${j.playbook.id}… `);
    try {
      const r = await analyzeCall(db, cfg, j.call.id, j.playbook);
      results.push(r);
      console.log(`${r.classificacao.toUpperCase()} · nota ${Math.round(r.nota)} · ${Math.round(r.duracao_ms / 1000)}s · US$ ${r.usd.toFixed(3)}${r.billing === "assinatura" ? " (equiv.)" : ""}`);
      for (const al of await alertAnalysis(db, cfg, r.analysis_id)) {
        const novos = al.results.filter((x) => x.status !== "duplicada");
        if (novos.length) console.log(`  ↳ alerta para ${al.destinatario}: ${novos.map((x) => `${x.canal} ${x.status}${x.erro ? ` (${x.erro})` : ""}`).join(", ")}`);
      }
    } catch (e) {
      console.log(`ERRO: ${(e as Error).message}`);
    }
  }
  if (!results.length) process.exit(1);

  console.log(
    "\n" +
      table(
        ["call", "playbook", "nota", "nota IA", "status", "etapas", "citações descart.", "churn", "custo US$"],
        results.map((r) => [
          r.call_id,
          r.playbook_id,
          String(Math.round(r.nota)),
          String(Math.round(r.nota_llm)),
          r.classificacao,
          r.etapas.map((e) => STATUS_ICON[e.status] ?? "?").join(" "),
          `${r.citacoes_descartadas}/${r.citacoes_total}`,
          String(r.churn),
          r.usd.toFixed(3) + (r.billing === "assinatura" ? "*" : ""),
        ]),
      ),
  );
  console.log("etapas: ● completo  ◐ parcial  ○ ausente   |  nota = recalculada após verificar as citações");
  if (results.some((r) => r.billing === "assinatura")) console.log("* custo equivalente em API; saiu da assinatura");
  for (const r of results.filter((x) => x.motivos.length)) console.log(`\n${r.call_id} × ${r.playbook_id} (${r.classificacao}):\n  - ${r.motivos.join("\n  - ")}`);
  const total = results.reduce((a, r) => a + r.usd, 0);
  console.log(`\nTotal: US$ ${total.toFixed(3)} / R$ ${(total * usdBrl()).toFixed(2)}${assinatura ? " (equivalente)" : ""}`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
