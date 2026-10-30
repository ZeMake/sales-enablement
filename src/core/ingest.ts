import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { matchPerson, type Config } from "./config";
import type { Db } from "./db/client";
import { calls, people, segments as segmentsTable } from "./db/schema";
import { llmAvailable } from "./llm/provider";
import { probeDuration, publishMedia } from "./media";
import { isUrl } from "./sources/url";
import { assignRoles, buildSegments, computeMetrics } from "./normalize";
import { parseTranscript } from "./parsers";
import type { ManifestRow } from "./sources/manifest";
import type { CallSource, SourceCall } from "./sources/types";
import { heuristicTriage, llmTriage, ruleTriage } from "./triage";
import type { CallMetrics, Role, Segment, Triage } from "./types";

export type IngestOptions = {
  force?: boolean; // reprocessa mesmo com hash igual
  llm?: boolean; // usa LIGHT_MODEL na triagem/papéis (default: se houver credencial)
  processedDir?: string;
  mediaDir?: string;
};

export type IngestResult = {
  call_id: string;
  acao: "ingerida" | "reprocessada" | "meta_atualizada" | "ignorada";
  motivo?: string;
  closer?: string;
  cliente?: string;
  metrics?: CallMetrics;
  triage?: Triage;
  flags?: string[];
  custoUsd?: number;
};

export async function syncPeople(db: Db, cfg: Config) {
  for (const p of cfg.team.pessoas) {
    const row = {
      id: p.id, nome: p.nome, papeis: p.papeis, gestores: p.gestores, aliases: p.aliases,
      whatsapp: p.whatsapp || null, slack: p.slack || null,
    };
    await db.insert(people).values(row).onConflictDoUpdate({ target: people.id, set: row });
  }
}

/** Campos de negócio vindos do manifest/nome do arquivo. Atualizá-los não reanalisa a call. */
function metaColumns(meta: ManifestRow, cfg: Config) {
  const resolve = (v?: string) =>
    v ? (cfg.team.pessoas.find((p) => p.id === v) ?? matchPerson(cfg.team, v))?.id : undefined;
  return {
    closer_id: resolve(meta.closer),
    gestor_id: resolve(meta.gestor),
    data_hora: meta.data_hora,
    lead_nome: meta.lead_nome,
    empresa: meta.empresa,
    produto: meta.produto,
    tipo_call: meta.tipo_call,
    desfecho: meta.desfecho,
    valor_venda: meta.valor_venda,
    crm_url: meta.crm_url,
    obs: meta.obs,
  };
}

/** Só sobrescreve com o que veio preenchido — um manifest parcial não apaga edição feita no painel. */
const definedOnly = <T extends Record<string, unknown>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;

export async function ingestCall(
  db: Db,
  cfg: Config,
  source: CallSource,
  sc: SourceCall,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const byHash = await db.select().from(calls).where(eq(calls.source_hash, sc.hash)).get();
  const byId = await db.select().from(calls).where(eq(calls.id, sc.call_id)).get();

  if (byHash && byHash.id !== sc.call_id)
    return { call_id: sc.call_id, acao: "ignorada", motivo: `duplicata de ${byHash.id} (mesmo conteúdo)` };
  if (byId && byId.source_hash !== sc.hash && !opts.force)
    return { call_id: sc.call_id, acao: "ignorada", motivo: "arquivo mudou desde a ingestão; use --force para reprocessar" };
  if (byHash && !opts.force) {
    const meta = definedOnly(metaColumns(sc.meta, cfg));
    if (sc.metaOrigem === "manifest" && Object.keys(meta).length)
      await db.update(calls).set({ ...meta, meta_origem: "manifest", updated_at: new Date().toISOString() }).where(eq(calls.id, sc.call_id));
    return { call_id: sc.call_id, acao: sc.metaOrigem === "manifest" ? "meta_atualizada" : "ignorada", motivo: "já ingerida" };
  }
  if (!sc.transcriptPath)
    return { call_id: sc.call_id, acao: "ignorada", motivo: "sem transcrição (transcrição por whisper desativada)" };

  // .txt do CRM não tem horário: a API manda à parte, linha a linha (sc.tempos).
  const raw = parseTranscript(sc.transcriptPath, await source.readTranscript(sc), sc.tempos);
  if (!raw.length) return { call_id: sc.call_id, acao: "ignorada", motivo: "transcrição vazia" };
  const durationSec = sc.videoPath ? await probeDuration(sc.videoPath) : undefined;
  const meta = metaColumns(sc.meta, cfg);

  const build = (llmRoles?: Record<string, Role>) => {
    const ra = assignRoles(raw, cfg.team, { closerHint: meta.closer_id, llmRoles });
    const b = buildSegments(raw, ra.roles, { durationSec, rules: cfg.rules });
    return { ra, ...b, metrics: computeMetrics(b.segments, b.estimado) };
  };

  let built = build();
  let triage = ruleTriage(built.segments, built.metrics, cfg.rules);
  let custoUsd = 0;
  let logTriageCost: (() => Promise<unknown>) | undefined;
  const useLlm = opts.llm ?? llmAvailable();
  if (!triage || triage.status === "pendente") {
    if (useLlm) {
      const r = await llmTriage(db, sc.call_id, built.segments);
      custoUsd = r.custoUsd;
      logTriageCost = r.logCost;
      built = build(r.roles);
      triage = ruleTriage(built.segments, built.metrics, cfg.rules) ?? r.triage;
    } else if (!triage) {
      triage = heuristicTriage();
    }
  }

  const { ra, segments, estimado, startIdx, metrics } = built;
  const flags = qualityFlags(segments, ra.metodo, estimado, !!ra.closerSpeaker);
  const cliente = [...new Set(segments.filter((s) => s.role === "cliente").map((s) => s.speaker))].join(", ");

  // Na Vercel só /tmp é gravável: PROCESSED_DIR aponta para lá.
  const processedDir = opts.processedDir ?? process.env.PROCESSED_DIR ?? "data/processed";
  fs.mkdirSync(processedDir, { recursive: true });
  fs.writeFileSync(
    path.join(processedDir, `${sc.call_id}.json`),
    JSON.stringify({ call_id: sc.call_id, source_hash: sc.hash, meta: sc.meta, tempo_estimado: estimado, call_start_idx: startIdx, speaker_roles: ra.roles, segments }, null, 2),
  );
  // Vídeo por link (CRM): o player toca direto do link, nada é copiado para o disco.
  const mediaPath = sc.videoPath ? (isUrl(sc.videoPath) ? sc.videoPath : publishMedia(sc.videoPath, opts.mediaDir ?? "data/media", sc.call_id)) : undefined;

  const row = {
    id: sc.call_id,
    source: source.name,
    source_hash: sc.hash,
    transcript_path: sc.transcriptPath,
    video_path: sc.videoPath,
    media_path: mediaPath,
    ...meta,
    closer_id: meta.closer_id ?? ra.closerId,
    meta_origem: sc.metaOrigem,
    closer_speaker: ra.closerSpeaker,
    speaker_roles: ra.roles,
    duration_sec: durationSec ?? metrics.duracao_total_seg,
    tempo_estimado: estimado,
    call_start_idx: startIdx,
    triage_status: triage.status,
    triage_motivo: triage.motivo,
    triage_metodo: triage.metodo,
    metrics,
    quality_flags: flags,
    updated_at: new Date().toISOString(),
  };
  await db.transaction(async (tx) => {
    await tx.delete(segmentsTable).where(eq(segmentsTable.call_id, sc.call_id));
    await tx.insert(calls).values(row).onConflictDoUpdate({ target: calls.id, set: row });
    await tx.insert(segmentsTable).values(segments.map((s) => ({ call_id: sc.call_id, ...s, flags: s.flags ?? null })));
  });
  await logTriageCost?.();

  return {
    call_id: sc.call_id,
    acao: byId ? "reprocessada" : "ingerida",
    closer: row.closer_id,
    cliente,
    metrics,
    triage,
    flags,
    custoUsd,
  };
}

function qualityFlags(
  segs: Segment[],
  metodo: Record<string, string>,
  estimado: boolean,
  closerFound: boolean,
): string[] {
  const f: string[] = [];
  if (estimado) f.push("tempo_estimado");
  if (!closerFound) f.push("closer_nao_identificado");
  if (segs.some((s) => s.flags?.includes("bastidor"))) f.push("bastidor");
  if (segs.some((s) => s.flags?.includes("ruido"))) f.push("ruido");
  if (segs.some((s) => s.role === "outro")) f.push("terceiros_da_make");
  if (Object.values(metodo).includes("heuristica")) f.push("papel_heuristico");
  return f;
}

/** Estimativa grosseira para a triagem (≈3,5 caracteres por token em PT-BR). */
export function estimateTriageTokens(transcripts: string[]): number {
  return transcripts.reduce((acc, t) => acc + Math.ceil(t.length / 3.5) + 600, 0);
}
