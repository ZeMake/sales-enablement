/**
 * pnpm ingest:url <link-da-transcrição> [mais links…] [--video <link>] [--closer <id>] [--desfecho ganho|perdido|…] [--no-llm]
 * Ingere reuniões direto dos links do CRM: lê a transcrição pela URL (sem salvar arquivo), acha o
 * vídeo ao lado (mesmo nome, .webm/.mp4) e mede a duração pelo link. O player toca do próprio link.
 * Depois: pnpm analyze --call <id>.
 */
import { loadConfig } from "../core/config";
import { openDb } from "../core/db/client";
import { ingestCall, syncPeople } from "../core/ingest";
import type { ManifestRow } from "../core/sources/manifest";
import { UrlSource } from "../core/sources/url";
import { flag, loadEnv, mmss, option } from "./_shared";

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  const valores = new Set(["--video", "--closer", "--desfecho"].flatMap((o) => (option(args, o.slice(2)) ? [option(args, o.slice(2))!] : [])));
  const links = args.filter((a) => /^https?:\/\//i.test(a) && !valores.has(a));
  if (!links.length) throw new Error("Passe o link da transcrição (.txt). Ex.: pnpm ingest:url https://storage.googleapis.com/…/Reunião.txt");
  const cfg = loadConfig();
  const db = await openDb();
  await syncPeople(db, cfg);
  const meta: Partial<ManifestRow> = {
    ...(option(args, "closer") ? { closer: option(args, "closer") } : {}),
    ...(option(args, "desfecho") ? { desfecho: option(args, "desfecho") as ManifestRow["desfecho"] } : {}),
  };
  const src = new UrlSource(
    links.map((l, i) => ({ transcriptUrl: l, videoUrl: i === 0 ? option(args, "video") : undefined, meta: Object.keys(meta).length ? meta : undefined })),
    cfg.team,
  );
  const { calls, warnings } = await src.list();
  for (const w of warnings) console.log(`! ${w}`);
  for (const sc of calls) {
    const r = await ingestCall(db, cfg, src, sc, { llm: flag(args, "no-llm") ? false : undefined, force: flag(args, "force") });
    console.log(`${sc.call_id} · ${sc.meta.obs}`);
    console.log(`  ${r.acao}${r.motivo ? ` (${r.motivo})` : ""}${r.metrics ? ` · ${mmss(r.metrics.duracao_total_seg)} · closer ${r.closer ?? "?"} · cliente ${r.cliente ?? "?"} · ${r.triage?.status}` : ""}`);
    console.log(`  vídeo: ${sc.videoPath ? "do link (não copiado)" : "sem vídeo"}`);
  }
  console.log("\nPróximo passo: pnpm analyze --call <id>");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
