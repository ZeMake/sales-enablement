"use server";

import { and, eq } from "drizzle-orm";
import { refresh } from "next/cache";
import { headers } from "next/headers";
import { analyses, calls, jobs, next_steps, notifications } from "@/core/db/schema";
import { analysisId } from "@/core/analysis/run";
import { isActive, loadPlaybooks } from "@/core/playbook";
import { getCallDetail } from "@/core/queries";
import { DESFECHOS } from "@/core/types";
import { adicionadasHoje, enqueue, jobsDaCall } from "@/core/jobs";
import { llmAvailable } from "@/core/llm/provider";
import { podeAdicionar, somenteLeitura } from "@/lib/acesso";
import { getContext } from "@/lib/server/context";
import { dispararFila } from "@/lib/server/fila";

/** Desfecho muda depois da call: atualiza sem reanalisar. */
export async function setDesfecho(callId: string, desfecho: string) {
  bloquearSeSomenteLeitura();
  const { db, viewer } = await getContext();
  if (!(await getCallDetail(db, viewer, callId))) throw new Error("Call fora do seu escopo");
  const value = (DESFECHOS as readonly string[]).includes(desfecho) ? desfecho : null;
  await db.update(calls).set({ desfecho: value, updated_at: new Date().toISOString() }).where(eq(calls.id, callId));
  refresh();
}

export async function setNextStepStatus(stepId: number, feito: boolean) {
  bloquearSeSomenteLeitura();
  const { db, viewer } = await getContext();
  const step = await db.select().from(next_steps).where(eq(next_steps.id, stepId)).get();
  if (!step || !(await getCallDetail(db, viewer, step.call_id))) throw new Error("Próximo passo fora do seu escopo");
  await db.update(next_steps).set({ status: feito ? "feito" : "pendente", updated_at: new Date().toISOString() }).where(eq(next_steps.id, stepId));
  refresh();
}

/** Marca uma notificação (só as do próprio viewer) como lida/não lida. */
export async function setNotificationRead(id: number, lida: boolean) {
  bloquearSeSomenteLeitura();
  const { db, viewer } = await getContext();
  await db.update(notifications).set({ lida }).where(and(eq(notifications.id, id), eq(notifications.destinatario_id, viewer.id)));
  refresh();
}

export async function markAllNotificationsRead() {
  bloquearSeSomenteLeitura();
  const { db, viewer } = await getContext();
  await db.update(notifications).set({ lida: true }).where(and(eq(notifications.destinatario_id, viewer.id), eq(notifications.lida, false)));
  refresh();
}

/** Versão de validação (READ_ONLY=true): ninguém altera dados pelo painel publicado. */
function bloquearSeSomenteLeitura() {
  if (somenteLeitura()) throw new Error("Versão de validação: somente leitura.");
}

// ---- Adicionar call pelo painel ----

export type EstadoAdicionar = { erro?: string; ok?: string };

/**
 * Coloca uma call na fila (link da transcrição ou texto colado + link do vídeo, opcional) e dispara o
 * processamento em segundo plano. A análise roda no PC, pela assinatura do Claude: na versão
 * publicada (só leitura) o botão fica desativado.
 */
export async function adicionarCall(_: EstadoAdicionar | undefined, form: FormData): Promise<EstadoAdicionar> {
  if (!podeAdicionar()) return { erro: "Versão de validação: para adicionar calls, use o painel local (a análise roda no PC)." };
  if (!llmAvailable()) return { erro: "Motor de IA indisponível: verifique a configuração (README → Motor de IA)." };
  const txt = (k: string) => String(form.get(k) ?? "").trim();
  const transcriptUrl = txt("transcricao_link");
  const transcriptText = txt("transcricao_texto");
  const videoUrl = txt("video_link");
  const closer = txt("closer");
  const desfecho = txt("desfecho");
  const titulo = txt("titulo");
  const http = /^https?:\/\/\S+$/i;
  if (!transcriptUrl && !transcriptText) return { erro: "Informe o link da transcrição ou cole o texto." };
  if (transcriptUrl && !http.test(transcriptUrl)) return { erro: "O link da transcrição precisa começar com http(s)://" };
  if (videoUrl && !http.test(videoUrl)) return { erro: "O link do vídeo precisa começar com http(s)://" };
  if (!transcriptUrl && transcriptText.length < 200) return { erro: "A transcrição colada está curta demais para uma call." };
  if (desfecho && !(DESFECHOS as readonly string[]).includes(desfecho)) return { erro: "Desfecho inválido." };
  const { db } = await getContext();
  const limite = Number(process.env.MAX_CALLS_DIA ?? 0);
  if (limite > 0 && (await adicionadasHoje(db)) >= limite) return { erro: `Limite de ${limite} calls por dia atingido (controle de custo). Tente amanhã.` };
  await enqueue(db, { transcriptUrl, transcriptText: transcriptUrl ? undefined : transcriptText, videoUrl, closer, desfecho, titulo });
  const h = await headers();
  await dispararFila(`${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`);
  refresh();
  return { ok: "Call na fila. A análise leva uns 5 minutos; acompanhe o status abaixo." };
}

/**
 * Analisa uma call já ingerida num playbook que ainda falta (ex.: make-closer depois do SPICED).
 * Vai pela mesma fila e conta no limite do dia, como uma call adicionada.
 */
export async function analisarComPlaybook(callId: string, playbookId: string) {
  if (!podeAdicionar()) throw new Error("Versão de validação: somente leitura.");
  if (!llmAvailable()) throw new Error("Motor de IA indisponível.");
  const pb = loadPlaybooks().find((p) => p.id === playbookId && isActive(p));
  if (!pb) throw new Error("Playbook inválido.");
  const { db, viewer } = await getContext();
  const d = await getCallDetail(db, viewer, callId);
  if (!d) throw new Error("Call fora do seu escopo");
  if (d.call.triage_status !== "comercial") throw new Error("Call não comercial: não recebe nota.");
  if (await db.select({ id: analyses.id }).from(analyses).where(eq(analyses.id, analysisId(callId, pb.id))).get()) return refresh();
  if ((await jobsDaCall(db, callId)).some((j) => j.status !== "erro")) return refresh();
  const limite = Number(process.env.MAX_CALLS_DIA ?? 0);
  if (limite > 0 && (await adicionadasHoje(db)) >= limite) throw new Error(`Limite de ${limite} análises por dia atingido (controle de custo). Tente amanhã.`);
  await enqueue(db, { callId, playbook: pb.id, titulo: `${d.lead} · ${pb.nome}` });
  const h = await headers();
  await dispararFila(`${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`);
  refresh();
}

/** Recoloca na fila uma call que deu erro. Retoma da etapa que falhou; não conta no limite do dia. */
export async function tentarDeNovo(jobId: number) {
  if (!podeAdicionar()) throw new Error("Versão de validação: somente leitura.");
  const { db } = await getContext();
  await db.update(jobs).set({ status: "na_fila", erro: null, etapa: "na fila (nova tentativa)", trava_ate: null }).where(and(eq(jobs.id, jobId), eq(jobs.status, "erro")));
  const h = await headers();
  await dispararFila(`${h.get("x-forwarded-proto") ?? "https"}://${h.get("host")}`);
  refresh();
}
