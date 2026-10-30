/**
 * Origem pela API do MakeCRM (somente leitura): lista as reuniões dos closers num período e devolve
 * os links da transcrição (.txt) e do vídeo, com os metadados do CRM (closer, data, lead, desfecho).
 * A leitura da transcrição continua com o UrlSource, pelo link do bucket.
 * Doc: GET /users, GET /users/{user}/meetings?from&to&limit&cursor, GET /meetings/{id}. 60 req/min.
 */
import { eq } from "drizzle-orm";
import { matchPerson, type Team } from "../config";
import type { Db } from "../db/client";
import { calls } from "../db/schema";
import type { ManifestRow } from "./manifest";
import type { UrlCall } from "./url";

const BASE = "https://htdjkprnspssogcetzhx.supabase.co/functions/v1/public-api/v1";

export type CrmUser = { id: string; name: string | null; email: string | null; role: string | null; active: boolean };
export type CrmMeeting = {
  id: string;
  title: string | null;
  status: "completed" | "no_show" | "pending";
  start_at: string | null;
  created_at: string;
  user_roles?: string[];
  deal: { id: string; name: string; status: "open" | "won" | "lost" } | null;
  contact: { id: string; name: string } | null;
  transcription: { video_url: string | null; transcript_url: string | null; summary?: { title?: string } | null } | null;
};

export class CrmApi {
  constructor(
    private key = process.env.MAKECRM_API_KEY ?? "",
    private fetcher: typeof fetch = fetch,
  ) {
    if (!key) throw new Error("Falta MAKECRM_API_KEY no .env (Configurações › Empresa › Chaves de API no MakeCRM).");
  }

  private async get<T>(rota: string, q: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams(Object.entries(q).flatMap(([k, v]) => (v === undefined ? [] : [[k, String(v)]])));
    for (;;) {
      const r = await this.fetcher(`${BASE}${rota}${qs.size ? `?${qs}` : ""}`, { headers: { Authorization: `Bearer ${this.key}` } });
      if (r.status === 429) {
        await new Promise((ok) => setTimeout(ok, Number(r.headers.get("Retry-After") ?? 5) * 1000));
        continue;
      }
      if (!r.ok) throw new Error(`MakeCRM ${rota}: ${r.status} ${await r.text()}`);
      return r.json() as Promise<T>;
    }
  }

  /** Início/fim de cada fala (s), da transcrição original do provedor; na mesma ordem do .txt. */
  async tempos(meetingId: string): Promise<Array<{ start: number; end: number }> | undefined> {
    const r = await this.get<{ data: { transcription: { transcript?: { raw?: { data?: Array<{ start: number; end: number }> } } | null } | null } }>(
      `/meetings/${meetingId}`,
      { include_raw: "true" },
    );
    const falas = r.data.transcription?.transcript?.raw?.data;
    return falas?.length ? falas.map((f) => ({ start: f.start, end: f.end })) : undefined;
  }

  async users(): Promise<CrmUser[]> {
    return (await this.get<{ data: CrmUser[] }>("/users")).data;
  }

  /** Todas as páginas de reuniões do usuário no período (datas YYYY-MM-DD, horário de São Paulo). */
  async meetings(user: string, from: string, to?: string): Promise<CrmMeeting[]> {
    const out: CrmMeeting[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.get<{ data: CrmMeeting[]; next_cursor: string | null }>(`/users/${encodeURIComponent(user)}/meetings`, { from, to, limit: 100, cursor });
      out.push(...r.data);
      cursor = r.next_cursor ?? undefined;
    } while (cursor);
    return out;
  }
}

const DESFECHO: Record<string, ManifestRow["desfecho"]> = { won: "ganho", lost: "perdido", open: "em_andamento" };

/** id da call: "crm-" + início do id da reunião (estável entre sincronizações). */
export const callIdDaReuniao = (id: string) => `crm-${id.slice(0, 8)}`;

/**
 * Reuniões gravadas dos closers do time no período, uma vez cada (a mesma reunião aparece para todos
 * os participantes). O closer provável é o convidado da reunião; o sync confere pelos falantes da transcrição.
 */
export type ReuniaoCrm = UrlCall & { meetingId: string; closers: string[] };

export async function reunioesDosClosers(api: CrmApi, team: Team, from: string, to?: string): Promise<{ itens: ReuniaoCrm[]; semGravacao: number }> {
  const closers = (await api.users()).filter((u) => u.role === "closer" && u.name && matchPerson(team, u.name)?.papeis.includes("closer"));
  const vistas = new Map<string, { m: CrmMeeting; closers: Array<{ id: string; peso: number }> }>();
  for (const u of closers) {
    const pessoa = matchPerson(team, u.name!)!;
    for (const m of await api.meetings(u.id, from, to)) {
      const v = vistas.get(m.id) ?? { m, closers: [] };
      const papeis = m.user_roles ?? [];
      // Quem estava na reunião (convidado/organizador) vem antes do closer da oportunidade, que pode ser outro.
      v.closers.push({ id: pessoa.id, peso: papeis.includes("attendee") || papeis.includes("organizer") ? 2 : papeis.includes("deal_closer") ? 1 : 0 });
      vistas.set(m.id, v);
    }
  }
  const itens: ReuniaoCrm[] = [];
  let semGravacao = 0;
  for (const { m, closers: cs } of vistas.values()) {
    const t = m.transcription;
    if (!t?.transcript_url) {
      semGravacao++;
      continue;
    }
    const closers = [...cs].sort((a, b) => b.peso - a.peso).map((c) => c.id);
    itens.push({
      meetingId: m.id,
      closers,
      transcriptUrl: t.transcript_url,
      videoUrl: t.video_url ?? undefined,
      meta: {
        call_id: callIdDaReuniao(m.id),
        closer: closers[0],
        data_hora: m.start_at ?? m.created_at,
        lead_nome: m.contact?.name?.trim() || m.title?.trim() || undefined,
        desfecho: m.deal ? DESFECHO[m.deal.status] : undefined,
        obs: t.summary?.title?.trim() || m.title?.trim() || undefined,
      },
    });
  }
  return { itens, semGravacao };
}

/**
 * A venda costuma fechar dias depois da call: relê no CRM o status da oportunidade de cada reunião já
 * no painel e grava ganho/perdido quando mudou. Oportunidade ainda aberta não mexe no que está lá.
 */
export async function atualizarDesfechos(db: Db, api: CrmApi, team: Team, from: string): Promise<Array<{ id: string; lead?: string; de: string | null; para: string }>> {
  const { itens } = await reunioesDosClosers(api, team, from);
  const mudaram: Array<{ id: string; lead?: string; de: string | null; para: string }> = [];
  for (const it of itens) {
    const para = it.meta?.desfecho;
    if (para !== "ganho" && para !== "perdido") continue;
    const id = it.meta!.call_id!;
    const atual = await db.select({ desfecho: calls.desfecho }).from(calls).where(eq(calls.id, id)).get();
    if (!atual || atual.desfecho === para) continue;
    await db.update(calls).set({ desfecho: para, updated_at: new Date().toISOString() }).where(eq(calls.id, id));
    mudaram.push({ id, lead: it.meta?.lead_nome, de: atual.desfecho, para });
  }
  return mudaram;
}
