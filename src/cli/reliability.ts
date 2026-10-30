/**
 * pnpm reliability --teste                      chamada de teste com texto inventado (nenhum dado de call)
 * pnpm reliability --call <id> | --all [--playbook <id>] [--yes]
 *   Pede ao Jev (TypeSafe, via OpenRouter) um segundo julgamento de cada etapa, risco de churn e
 *   objeção já analisados pelo Opus e grava a confiabilidade (alta / média / divergente).
 *   Manda a transcrição com dados pessoais mascarados (JEV_MASK_PII=false desliga).
 */
import { eq, isNotNull, and } from "drizzle-orm";
import { estimateReliability, runReliability, summarize, type ReliabilityItem } from "../core/analysis/reliability";
import { openDb } from "../core/db/client";
import { analyses } from "../core/db/schema";
import { usdBrl } from "../core/llm/pricing";
import { decide, jevAvailable, jevMaskPii, jevModel } from "../core/llm/jev";
import { isActive, loadPlaybooks } from "../core/playbook";
import { loadConfig } from "../core/config";
import { flag, loadEnv, option, table } from "./_shared";

const CONFIRM_ABOVE = 3;
const KIND: Record<string, string> = { etapa: "etapas", churn: "riscos de churn", objecao_existe: "objeções (existe?)", objecao_resolvida: "objeções (resolvida?)" };

async function teste() {
  const res = await decide({
    state: "[1] (closer) Ana: Com a gente você vai ter no mínimo 300 leads por mês, garantido.\n[2] (cliente) Carlos: Garantido mesmo?\n[3] (closer) Ana: Garantido.",
    questions: {
      promessa: { type: "noul", instructions: "A closer prometeu um número de leads como garantido?", criteria: { true: "Sim, prometeu número garantido.", false: "Não prometeu resultado garantido." } },
      severidade: { type: "choice", instructions: "Qual a severidade desse risco de churn?", criteria: { vermelho: "Violação explícita de promessa proibida.", amarelo: "Expectativa exagerada ou ambígua.", nenhum: "Sem risco." } },
    },
  });
  console.log(JSON.stringify(res, null, 2));
  console.log(`\nOK: ${res.model} via ${res.provider} · ${res.usage.input_tokens} tokens · US$ ${res.usage.cost}`);
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  if (!jevAvailable()) throw new Error("Defina OPENROUTER_API_KEY no .env");
  if (flag(args, "teste")) return teste();

  const db = await openDb();
  const playbooks = loadPlaybooks().filter(isActive);
  const wanted = option(args, "playbook");
  const callId = option(args, "call");
  if (!callId && !flag(args, "all")) throw new Error("Use --teste, --call <id> ou --all");
  const rows = await db
    .select({ id: analyses.id, call: analyses.call_id, playbook: analyses.playbook_id })
    .from(analyses)
    .where(and(isNotNull(analyses.result), callId ? eq(analyses.call_id, callId) : undefined, wanted ? eq(analyses.playbook_id, wanted) : undefined))
    .orderBy(analyses.call_id);
  const jobs = rows.map((r) => ({ ...r, pb: playbooks.find((p) => p.id === r.playbook) })).filter((r) => r.pb);
  if (!jobs.length) throw new Error("Nenhuma análise encontrada");

  let tokens = 0, usd = 0;
  for (const j of jobs) {
    const e = await estimateReliability(db, j.id, j.pb!);
    tokens += e.tokens;
    usd += e.usd;
  }
  console.log(`Estimativa: ${jobs.length} análise(s), ~${Math.round(tokens / 1000)}k tokens de entrada, ~US$ ${usd.toFixed(4)} / ~R$ ${(usd * usdBrl()).toFixed(3)} (${jevModel()}, só entrada é cobrada)`);
  console.log(`Dados: transcrição ${jevMaskPii() ? "com CPF/CNPJ, telefone, e-mail e cartão mascarados" : "SEM mascaramento (JEV_MASK_PII=false)"} vai para OpenRouter → TypeSafe, com data_collection=deny.`);
  if (jobs.length > CONFIRM_ABOVE && !flag(args, "yes")) {
    console.log(`Mais de ${CONFIRM_ABOVE} análises: confirme com --yes.`);
    process.exit(1);
  }

  const out: string[][] = [];
  const divergentes: string[] = [];
  let total = 0;
  for (const [i, j] of jobs.entries()) {
    process.stdout.write(`[${i + 1}/${jobs.length}] ${j.call} × ${j.playbook}… `);
    try {
      const r = await runReliability(db, j.id, j.pb!, { cfg: loadConfig() });
      total += r.usd;
      console.log(`${r.respondidas}/${r.perguntas} respostas · contexto ${r.contexto} · US$ ${r.usd.toFixed(5)}`);
      const s = summarize(r.items);
      const cel = (k: string) => {
        const x = s.find((y) => y.kind === k);
        return x ? `${x.alta}/${x.media}/${x.divergente}` : "—";
      };
      out.push([j.call, j.playbook, cel("etapa"), cel("churn"), cel("objecao_existe"), cel("objecao_resolvida")]);
      for (const it of r.items.filter((x) => x.nivel === "divergente")) divergentes.push(`${j.call} × ${j.playbook} · ${descrever(it, j.pb!)}`);
    } catch (e) {
      console.log(`ERRO: ${(e as Error).message}`);
    }
  }
  if (!out.length) process.exit(1);
  console.log("\n" + table(["call", "playbook", "etapas", "churn", "objeção existe", "objeção resolvida"], out));
  console.log("cada célula: alta / média / divergente (divergente = o Jev discorda do Opus)");
  if (divergentes.length) console.log(`\nDivergências (${divergentes.length}):\n  - ${divergentes.join("\n  - ")}`);
  console.log(`\nTotal: US$ ${total.toFixed(5)} / R$ ${(total * usdBrl()).toFixed(4)} (custo real da OpenRouter)`);
}

function descrever(it: ReliabilityItem, pb: { etapas: Array<{ id: string; nome: string }> }) {
  const p = `${Math.round(it.prob * 100)}%`;
  if (it.kind === "etapa") return `etapa ${pb.etapas.find((e) => e.id === it.ref)?.nome ?? it.ref}: Opus ${it.opus}, Jev ${it.jev} (${p})`;
  return `${KIND[it.kind]} #${Number(it.ref) + 1}: Opus ${it.opus}, Jev ${it.jev} (${p})`;
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
