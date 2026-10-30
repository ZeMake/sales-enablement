/**
 * pnpm ingest [--force] [--no-llm] [--yes]
 * Lê data/inbox/, normaliza, faz triagem e calcula métricas determinísticas.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../core/config";
import { openDb } from "../core/db/client";
import { calls } from "../core/db/schema";
import { estimateTriageTokens, ingestCall, syncPeople, type IngestResult } from "../core/ingest";
import type { CallMetrics } from "../core/types";
import { lightModel } from "../core/llm/client";
import { getProvider, llmAvailable } from "../core/llm/provider";
import { costUsd, usdBrl } from "../core/llm/pricing";
import { toManifestCsv, type ManifestRow } from "../core/sources/manifest";
import { LocalFolderSource } from "../core/sources/local-folder";
import { flag, loadEnv, mmss, pct, table } from "./_shared";

const CONFIRM_ABOVE_CALLS = 10;

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const cfg = loadConfig();
  const db = await openDb();
  await syncPeople(db, cfg);

  const inbox = "data/inbox";
  const source = new LocalFolderSource(inbox, cfg.team);
  const { calls: found, warnings } = await source.list();
  warnings.forEach((w) => console.warn(`⚠ ${w}`));

  const useLlm = !flag(args, "no-llm") && llmAvailable();
  if (!useLlm)
    console.log(
      flag(args, "no-llm")
        ? "Triagem sem LLM (--no-llm): heurística."
        : "LLM indisponível (sem Claude Code CLI ou sem chave de API): triagem e papéis por heurística.",
    );

  const known = new Set((await db.select({ h: calls.source_hash }).from(calls)).map((r) => r.h));
  const pending = found.filter((c) => c.transcriptPath && (flag(args, "force") || !known.has(c.hash)));
  if (useLlm && pending.length) {
    const tokens = estimateTriageTokens(pending.map((c) => fs.readFileSync(c.transcriptPath!, "utf8")));
    const usd = costUsd(lightModel(), { input_tokens: tokens, output_tokens: pending.length * 400 });
    const billing = getProvider().name === "claude-cli" ? " — consumo da assinatura, custo equivalente" : "";
    console.log(
      `Estimativa de triagem: ${pending.length} calls, ~${Math.round(tokens / 1000)}k tokens, ~US$ ${usd.toFixed(3)} / ~R$ ${(usd * usdBrl()).toFixed(2)} (${lightModel()})${billing}`,
    );
    if (pending.length > CONFIRM_ABOVE_CALLS && !flag(args, "yes")) {
      console.log(`Mais de ${CONFIRM_ABOVE_CALLS} calls: confirme rodando com --yes.`);
      process.exit(1);
    }
  }

  const results: IngestResult[] = [];
  for (const sc of found) {
    try {
      results.push(await ingestCall(db, cfg, source, sc, { force: flag(args, "force"), llm: useLlm }));
    } catch (e) {
      results.push({ call_id: sc.call_id, acao: "ignorada", motivo: `erro: ${(e as Error).message}` });
    }
  }

  const all = await db.select().from(calls).all();
  if (all.length) {
    console.log(
      "\n" +
        table(
          ["call", "closer", "cliente", "duração", "efetiva", "closer%", "cliente%", "outro%", "monólogo", "perg. C/L", "triagem", "flags"],
          all.map((c) => {
            const m = c.metrics as unknown as CallMetrics;
            const cliente = Object.entries(c.speaker_roles).filter(([, r]) => r === "cliente").map(([s]) => s).join(", ");
            return [
              c.id,
              c.closer_id ?? "?",
              truncate(cliente, 24),
              mmss(m.duracao_total_seg),
              mmss(m.duracao_efetiva_seg),
              pct(m.fala_pct.closer),
              pct(m.fala_pct.cliente),
              pct(m.fala_pct.outro),
              mmss(m.maior_monologo_closer_seg),
              `${m.perguntas.closer}/${m.perguntas.cliente}`,
              `${c.triage_status} (${c.triage_metodo})`,
              c.quality_flags.join(","),
            ];
          }),
        ),
    );
    if (all.some((c) => c.tempo_estimado))
      console.log("Tempos estimados (sem timestamps): duração do vídeo distribuída proporcionalmente às palavras.");
  }
  const skipped = results.filter((r) => !r.metrics);
  if (skipped.length) {
    console.log("\nSem processamento:");
    for (const r of skipped) console.log(`  • ${r.call_id}: ${r.acao} — ${r.motivo}`);
  }
  const total = results.reduce((a, r) => a + (r.custoUsd ?? 0), 0);
  if (total) console.log(`\nCusto desta execução${getProvider().name === "claude-cli" ? " (equivalente; saiu da assinatura)" : ""}: US$ ${total.toFixed(4)} / R$ ${(total * usdBrl()).toFixed(3)}`);

  // Manifest sugerido com o que já se sabe de cada call, para completar desfecho, produto etc.
  const rows: ManifestRow[] = (await db.select().from(calls).all()).map((c) => ({
    call_id: c.id,
    transcricao: c.transcript_path ? path.basename(c.transcript_path) : undefined,
    video: c.video_path ? path.basename(c.video_path) : undefined,
    closer: c.closer_id ?? undefined,
    gestor: c.gestor_id ?? undefined,
    data_hora: c.data_hora ?? undefined,
    lead_nome: c.lead_nome ?? undefined,
    empresa: c.empresa ?? undefined,
    produto: c.produto ?? undefined,
    tipo_call: (c.tipo_call ?? undefined) as ManifestRow["tipo_call"],
    desfecho: (c.desfecho ?? undefined) as ManifestRow["desfecho"],
    valor_venda: c.valor_venda ?? undefined,
    crm_url: c.crm_url ?? undefined,
    obs: c.obs ?? undefined,
  }));
  const sugerido = path.join(inbox, "manifest.sugerido.csv");
  fs.writeFileSync(sugerido, toManifestCsv(rows));
  console.log(`\nManifest sugerido em ${sugerido} — complete e salve como manifest.csv, depois rode pnpm ingest de novo.`);
}

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
