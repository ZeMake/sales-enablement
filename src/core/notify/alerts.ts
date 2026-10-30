import { and, eq } from "drizzle-orm";
import type { Config, Person } from "../config";
import type { Db } from "../db/client";
import { analyses, calls, churn_flags } from "../db/schema";
import { leadName } from "../queries";
import { dispatch, panelUrl, type DispatchResult, type Notificacao, type Notifier } from "./index";

/** Quem recebe alertas de um closer: os gestores dele; sem gestor, os admins. */
export function recipientsFor(cfg: Config, closerId: string | null): Person[] {
  const closer = cfg.team.pessoas.find((p) => p.id === closerId);
  const gestores = cfg.team.pessoas.filter((p) => closer?.gestores.includes(p.id));
  return gestores.length ? gestores : cfg.team.pessoas.filter((p) => p.papeis.includes("admin"));
}

const tipo = (s: string) => s.replace(/_/g, " ");
const STATUS: Record<string, string> = { ok: "ok", atencao: "atenção", critica: "crítica" };

/**
 * Alerta imediato quando a análise termina crítica ou com churn vermelho.
 * Um alerta por call × gestor (chave `alerta:<call>`): reanalisar ou o outro playbook não repete.
 */
export async function buildAlerts(db: Db, cfg: Config, analysisId: string): Promise<Notificacao[]> {
  const a = await db.select().from(analyses).where(eq(analyses.id, analysisId)).get();
  if (!a) throw new Error(`Análise ${analysisId} não encontrada`);
  const vermelhos = await db.select().from(churn_flags).where(and(eq(churn_flags.analysis_id, a.id), eq(churn_flags.severidade, "vermelho")));
  if (a.classificacao !== "critica" && !vermelhos.length) return [];

  const call = (await db.select().from(calls).where(eq(calls.id, a.call_id)).get())!;
  const closer = cfg.team.pessoas.find((p) => p.id === call.closer_id);
  const lead = leadName(call);
  const nota = a.nota_aderencia == null ? "—" : String(Math.round(a.nota_aderencia));
  const motivoTitulo = vermelhos.length ? "churn vermelho" : "call crítica";
  const url = `${panelUrl()}/calls/${call.id}?playbook=${a.playbook_id}`;
  const churn = vermelhos.slice(0, 2).map((v) => `${tipo(v.tipo)}: “${v.citacao}”${v.como_deveria_ter_dito ? ` → melhor: “${v.como_deveria_ter_dito}”` : ""}`);

  return recipientsFor(cfg, call.closer_id).map((g) => ({
    tipo: "alerta_critica",
    destinatario: g,
    chave: `alerta:${call.id}`,
    call_id: call.id,
    titulo: `Alerta: ${motivoTitulo} — ${closer?.nome ?? call.closer_id ?? "closer?"} com ${lead}`,
    resumo: `Nota ${nota} no playbook ${a.playbook_id} · ${a.classificacao ? STATUS[a.classificacao] : "sem classificação"}`,
    secoes: [
      { titulo: "Por quê", itens: (a.motivos ?? []).slice(0, 4) },
      { titulo: "Risco de churn", itens: churn },
    ],
    links: [{ label: "Abrir a call", url }],
    dados: { analysis_id: a.id, playbook_id: a.playbook_id, nota: a.nota_aderencia, classificacao: a.classificacao, churn_vermelho: vermelhos.length },
  }));
}

export async function alertAnalysis(
  db: Db,
  cfg: Config,
  analysisId: string,
  opts: { notifiers?: Notifier[]; dryRun?: boolean; outDir?: string } = {},
): Promise<Array<{ destinatario: string; results: DispatchResult[] }>> {
  const out = [];
  for (const n of await buildAlerts(db, cfg, analysisId)) out.push({ destinatario: n.destinatario.id, results: await dispatch(db, n, opts) });
  return out;
}
