/**
 * Origem por link (armazenamento do CRM): transcrição e vídeo lidos direto da URL, sem cópia em disco.
 * É o primeiro passo da integração com o CRM: hoje recebe os links à mão; depois, a API do CRM
 * entrega os mesmos links.
 *
 * Exemplo de link (bucket do MakeCRM):
 *   https://storage.googleapis.com/makecrm_meet/<conta>/<reunião>/<título>.txt   (e .webm ao lado)
 */
import crypto from "node:crypto";
import type { Team } from "../config";
import { inferFromFilename } from "./local-folder";
import type { ManifestRow } from "./manifest";
import type { CallSource, SourceCall } from "./types";

export const isUrl = (s?: string | null): s is string => !!s && /^https?:\/\//i.test(s);

/** Transcrição por link (.txt do CRM) ou colada como texto; vídeo por link, opcional. */
export type UrlCall = { transcriptUrl?: string; transcriptText?: string; videoUrl?: string; meta?: Partial<ManifestRow>; tempos?: SourceCall["tempos"] };

/** Chave interna de uma transcrição colada (termina em .txt para o parser certo). */
const chaveTexto = (texto: string) => `colada:${crypto.createHash("sha256").update(texto).digest("hex").slice(0, 16)}.txt`;

/** Título da reunião a partir do nome do arquivo no link ("Reunião sobre …"). */
export function tituloDoLink(url: string): string {
  const nome = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
  return nome.replace(/\.[a-z0-9]+$/i, "").trim();
}

/** id estável e curto: "crm-" + início do id da reunião no caminho (ou um hash do link). */
export function callIdDoLink(url: string): string {
  const partes = new URL(url).pathname.split("/").filter(Boolean);
  const uuid = [...partes].reverse().find((p) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(p));
  return `crm-${uuid ? uuid.slice(0, 8) : crypto.createHash("sha256").update(url).digest("hex").slice(0, 8)}`;
}

/** O vídeo costuma estar ao lado da transcrição, com o mesmo nome: confere se existe. */
export async function acharVideoAoLado(transcriptUrl: string, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  for (const ext of [".webm", ".mp4"]) {
    const candidato = transcriptUrl.replace(/\.[a-z0-9]+(\?.*)?$/i, ext);
    if (candidato === transcriptUrl) continue;
    const r = await fetcher(candidato, { method: "HEAD" }).catch(() => undefined);
    if (r?.ok) return candidato;
  }
  return undefined;
}

export class UrlSource implements CallSource {
  readonly name = "link";
  private textos = new Map<string, string>();
  constructor(
    private itens: UrlCall[],
    private team: Team,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async texto(url: string): Promise<string> {
    if (!this.textos.has(url)) {
      if (!isUrl(url)) throw new Error(`Transcrição não encontrada: ${url}`);
      const r = await this.fetcher(url);
      if (!r.ok) throw new Error(`Transcrição indisponível (${r.status}): ${url}`);
      this.textos.set(url, await r.text());
    }
    return this.textos.get(url)!;
  }

  async list() {
    const warnings: string[] = [];
    const calls: SourceCall[] = [];
    for (const it of this.itens) {
      let chave: string;
      if (it.transcriptUrl) chave = it.transcriptUrl;
      else if (it.transcriptText?.trim()) {
        chave = chaveTexto(it.transcriptText);
        this.textos.set(chave, it.transcriptText);
      } else throw new Error("Informe o link da transcrição ou cole o texto.");
      const texto = await this.texto(chave);
      const titulo = it.meta?.obs ?? (it.transcriptUrl ? tituloDoLink(it.transcriptUrl) : it.videoUrl ? tituloDoLink(it.videoUrl) : "Transcrição colada");
      const inferido = inferFromFilename(titulo, this.team);
      const videoUrl = it.videoUrl ?? (it.transcriptUrl ? await acharVideoAoLado(it.transcriptUrl, this.fetcher) : undefined);
      if (!videoUrl) warnings.push(`${titulo}: sem vídeo (segue só com a transcrição)`);
      const hash = crypto.createHash("sha256").update(texto).digest("hex");
      const call_id = it.meta?.call_id ?? (it.transcriptUrl ? callIdDoLink(it.transcriptUrl) : videoUrl ? callIdDoLink(videoUrl) : `colada-${hash.slice(0, 8)}`);
      calls.push({
        call_id,
        hash,
        transcriptPath: chave,
        videoPath: videoUrl,
        meta: { ...inferido, ...it.meta, call_id, obs: titulo } as ManifestRow,
        tempos: it.tempos,
        metaOrigem: it.meta && Object.keys(it.meta).length ? "manifest" : "nome_do_arquivo",
      });
    }
    return { calls, warnings };
  }

  readTranscript(call: SourceCall): Promise<string> {
    return this.texto(call.transcriptPath!);
  }
}
