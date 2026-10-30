import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Rules } from "./config";
import type { Db } from "./db/client";
import { lightModel, logCost } from "./llm/client";
import { getProvider } from "./llm/provider";
import { maskPii, shouldMaskPii } from "./pii";
import type { CallMetrics, Role, Segment, Triage } from "./types";

export const TRIAGE_PROMPT_VERSION = "triage.v1";

/** Regras em código, antes de gastar token. Retorna a triagem se já for conclusiva. */
export function ruleTriage(segs: Segment[], metrics: CallMetrics, rules: Rules): Triage | undefined {
  const min = rules.ingestao.duracao_minima_min;
  if (!segs.some((s) => s.role === "cliente" && !s.flags?.includes("ruido")))
    return { status: "nao_comercial", motivo: "Nenhuma fala de cliente identificada", metodo: "regra" };
  if (!segs.some((s) => s.role === "closer"))
    return { status: "pendente", motivo: "Closer do time não identificado nos falantes", metodo: "regra" };
  if (metrics.duracao_efetiva_seg < min * 60)
    return {
      status: "nao_comercial",
      motivo: `Duração efetiva ${Math.round(metrics.duracao_efetiva_seg / 60)} min abaixo do mínimo de ${min} min`,
      metodo: "regra",
    };
  return undefined;
}

/** Sem API: closer e cliente presentes e duração ok → comercial (a confirmar pelo LLM). */
export function heuristicTriage(): Triage {
  return {
    status: "comercial",
    motivo: "Closer e cliente conversando acima da duração mínima (heurística; confirmar com LLM)",
    metodo: "heuristica",
  };
}

const TriageOutput = z.object({
  comercial: z.boolean(),
  tipo: z.enum(["venda_com_lead", "treinamento", "entrevista", "reuniao_interna", "suporte", "no_show", "outro"]),
  motivo: z.string(),
  falantes: z.array(
    z.object({ speaker: z.string(), papel: z.enum(["closer", "cliente", "outro"]), justificativa: z.string() }),
  ),
});

const MAX_SEG_CHARS = 600;

export function renderForTriage(segs: Pick<Segment, "idx" | "speaker" | "text">[]): string {
  const mask = shouldMaskPii();
  return segs
    .map((s) => {
      const t = s.text.length > MAX_SEG_CHARS ? s.text.slice(0, MAX_SEG_CHARS) + " […]" : s.text;
      return `[${s.idx}] ${s.speaker}: ${mask ? maskPii(t) : t}`;
    })
    .join("\n");
}

/** Triagem + papel dos falantes numa única chamada ao LIGHT_MODEL. */
export async function llmTriage(
  db: Db,
  callId: string,
  segs: Segment[],
): Promise<{ triage: Triage; roles: Record<string, Role>; custoUsd: number; logCost: () => Promise<unknown> }> {
  const model = lightModel();
  const system = fs.readFileSync(path.join(process.cwd(), "prompts", `${TRIAGE_PROMPT_VERSION}.md`), "utf8");
  const speakers = [...new Set(segs.map((s) => s.speaker))];
  const res = await getProvider().complete({
    model,
    system,
    user: `Falantes: ${speakers.join(" | ")}\n\n<transcricao>\n${renderForTriage(segs)}\n</transcricao>`,
    schema: TriageOutput,
    temperature: 0,
    maxTokens: 2048,
    timeoutMs: 5 * 60_000,
  });
  // O custo só pode ser gravado depois que a call existir no banco (chave estrangeira).
  const log = () => logCost(db, { call_id: callId, etapa: "triagem", model, usage: res.usage, usd: res.costUsd, billing: res.billing });
  const out = res.data;
  const roles: Record<string, Role> = {};
  for (const f of out.falantes) if (speakers.includes(f.speaker)) roles[f.speaker] = f.papel;
  return {
    triage: {
      status: out.comercial ? "comercial" : "nao_comercial",
      motivo: `${out.tipo}: ${out.motivo}`,
      metodo: "llm",
    },
    roles,
    custoUsd: res.costUsd,
    logCost: log,
  };
}
