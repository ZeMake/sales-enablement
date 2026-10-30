import "server-only";
import { cache } from "react";
import { loadConfig } from "@/core/config";
import { isActive, loadPlaybooks } from "@/core/playbook";
import { getViewer, mostAnalyzedPlaybook } from "@/core/queries";
import { db } from "./db";

/**
 * Contexto por requisição. Na V1 local não há login: o viewer vem de VIEWER_ID (padrão: victor, admin).
 * Quando houver autenticação, é só trocar a origem do viewer — as queries já filtram por escopo.
 */
export const getContext = cache(async () => {
  const conn = await db();
  const cfg = loadConfig();
  const playbooks = loadPlaybooks().filter(isActive);
  const viewer = await getViewer(conn, process.env.VIEWER_ID ?? "victor");
  const stageName = (playbookId: string, stageId: string) =>
    playbooks.find((p) => p.id === playbookId)?.etapas.find((e) => e.id === stageId)?.nome ?? stageId;
  return { db: conn, cfg, playbooks, viewer, stageName, barra: cfg.rules.classificacao.barra_minima_aderencia };
});

/** Playbook pedido na URL; sem pedido, o que tem mais calls analisadas (empate → playbook da Make). */
export async function resolvePlaybook(requested?: string | string[]): Promise<string> {
  const { db: conn, playbooks } = await getContext();
  const r = Array.isArray(requested) ? requested[0] : requested;
  const asked = playbooks.find((p) => p.id === r)?.id;
  if (asked) return asked;
  return mostAnalyzedPlaybook(conn, playbooks.map((p) => p.id));
}
