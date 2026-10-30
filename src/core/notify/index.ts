/**
 * Notificações: uma mensagem estruturada, formatada por canal (painel, Slack, WhatsApp).
 * NOTIFY_DRY_RUN=true (padrão): nada sai para fora; cada canal grava o que enviaria em
 * out/notifications/<data>/ e no banco. O painel é sempre ativo.
 */
import fs from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import type { Person } from "../config";
import type { Db } from "../db/client";
import { notifications } from "../db/schema";

export type TipoNotificacao = "alerta_critica" | "relatorio_diario";
export type Canal = "painel" | "slack" | "whatsapp";

export type Notificacao = {
  tipo: TipoNotificacao;
  destinatario: Pick<Person, "id" | "nome" | "slack" | "whatsapp">;
  /** Deduplicação: mesma chave + canal não é gerada de novo. */
  chave: string;
  call_id?: string;
  titulo: string;
  /** Uma linha de contexto logo abaixo do título. */
  resumo?: string;
  secoes: Array<{ titulo?: string; itens: string[] }>;
  links: Array<{ label: string; url: string }>;
  /** Dados brutos (para o painel e para depuração). */
  dados?: Record<string, unknown>;
};

export const panelUrl = () => (process.env.PANEL_URL ?? "http://localhost:3000").replace(/\/$/, "");
export const dryRun = () => process.env.NOTIFY_DRY_RUN !== "false";

// ---- formatação ----

/** Texto curto e sem markdown pesado (WhatsApp, painel e arquivo .txt). */
export function toText(n: Notificacao): string {
  const out = [n.titulo];
  if (n.resumo) out.push(n.resumo);
  for (const s of n.secoes) {
    if (!s.itens.length) continue;
    out.push("");
    if (s.titulo) out.push(s.titulo);
    out.push(...s.itens.map((i) => `- ${i}`));
  }
  if (n.links.length) out.push("", ...n.links.map((l) => `${l.label}: ${l.url}`));
  return out.join("\n");
}

/** Slack Block Kit (Incoming Webhook). */
export function toSlackBlocks(n: Notificacao): { text: string; blocks: unknown[] } {
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const mention = n.destinatario.slack ? `<@${n.destinatario.slack}> ` : "";
  const blocks: unknown[] = [{ type: "header", text: { type: "plain_text", text: n.titulo.slice(0, 150) } }];
  if (n.resumo) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: mention + esc(n.resumo) }] });
  for (const s of n.secoes) {
    if (!s.itens.length) continue;
    const body = s.itens.map((i) => `• ${esc(i)}`).join("\n");
    blocks.push({ type: "section", text: { type: "mrkdwn", text: (s.titulo ? `*${esc(s.titulo)}*\n` : "") + body.slice(0, 2900) } });
  }
  if (n.links.length)
    blocks.push({
      type: "actions",
      elements: n.links.slice(0, 5).map((l) => ({ type: "button", text: { type: "plain_text", text: l.label.slice(0, 75) }, url: l.url })),
    });
  return { text: `${mention}${n.titulo}`, blocks };
}

// ---- canais ----

export interface Notifier {
  canal: Canal;
  /** Envio real. Só é chamado fora do dry-run (o painel não envia nada: só grava no banco). */
  send(n: Notificacao): Promise<void>;
  /** O que este canal enviaria, para o arquivo do dry-run. */
  preview(n: Notificacao): { ext: string; body: string };
}

export const PanelNotifier: Notifier = {
  canal: "painel",
  async send() {},
  preview: (n) => ({ ext: "txt", body: toText(n) }),
};

export function slackNotifier(webhook = process.env.SLACK_WEBHOOK_URL): Notifier {
  return {
    canal: "slack",
    async send(n) {
      if (!webhook) throw new Error("SLACK_WEBHOOK_URL não configurado");
      const res = await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(toSlackBlocks(n)) });
      if (!res.ok) throw new Error(`Slack respondeu ${res.status}: ${await res.text()}`);
    },
    preview: (n) => ({ ext: "json", body: JSON.stringify(toSlackBlocks(n), null, 2) }),
  };
}

/** Provedor de WhatsApp ainda não definido: a interface está pronta, o envio real não. */
export const WhatsAppNotifier: Notifier = {
  canal: "whatsapp",
  async send(n) {
    if (!n.destinatario.whatsapp) throw new Error(`${n.destinatario.nome} sem whatsapp no team.yaml`);
    throw new Error("Provedor de WhatsApp não definido (pendência)");
  },
  preview: (n) => ({ ext: "txt", body: toText(n) }),
};

export const defaultNotifiers = (): Notifier[] => [PanelNotifier, slackNotifier(), WhatsAppNotifier];

// ---- despacho ----

export type DispatchResult = { canal: Canal; status: "gerada" | "enviada" | "erro" | "duplicada"; arquivo?: string; erro?: string };

const slug = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

export async function dispatch(
  db: Db,
  n: Notificacao,
  opts: { notifiers?: Notifier[]; dryRun?: boolean; outDir?: string; now?: Date; /** Gera de novo mesmo se a chave já existir. */ replace?: boolean } = {},
): Promise<DispatchResult[]> {
  const notifiers = opts.notifiers ?? defaultNotifiers();
  const dry = opts.dryRun ?? dryRun();
  const now = opts.now ?? new Date();
  // turbopackIgnore: pasta de saída local (dry-run); sem isso o build da Vercel empacota o projeto inteiro.
  const dir = path.join(/*turbopackIgnore: true*/ opts.outDir ?? process.env.NOTIFY_OUT_DIR ?? "out/notifications", now.toLocaleDateString("sv-SE"));
  const results: DispatchResult[] = [];

  for (const nt of notifiers) {
    const mesma = and(eq(notifications.chave, n.chave), eq(notifications.canal, nt.canal), eq(notifications.destinatario_id, n.destinatario.id));
    if (opts.replace) await db.delete(notifications).where(mesma);
    const dup = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(mesma)
      .get();
    if (dup) {
      results.push({ canal: nt.canal, status: "duplicada" });
      continue;
    }

    let status: DispatchResult["status"] = "enviada";
    let erro: string | undefined;
    let arquivo: string | undefined;
    if (dry) {
      const p = nt.preview(n);
      fs.mkdirSync(dir, { recursive: true });
      arquivo = path.join(dir, `${slug(n.chave)}--${n.destinatario.id}--${nt.canal}.${p.ext}`);
      fs.writeFileSync(arquivo, p.body);
      status = nt.canal === "painel" ? "enviada" : "gerada";
    } else if (nt.canal !== "painel") {
      try {
        await nt.send(n);
      } catch (e) {
        status = "erro";
        erro = (e as Error).message;
      }
    }

    await db.insert(notifications).values({
      canal: nt.canal,
      destinatario_id: n.destinatario.id,
      tipo: n.tipo,
      chave: n.chave,
      call_id: n.call_id,
      payload: { titulo: n.titulo, resumo: n.resumo, secoes: n.secoes, links: n.links, texto: toText(n), dados: n.dados ?? {} },
      dry_run: dry,
      status,
      erro,
    });
    results.push({ canal: nt.canal, status, arquivo, erro });
  }
  return results;
}
