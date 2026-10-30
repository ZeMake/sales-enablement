import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { matchPerson, normName, type Team } from "../config";
import { TRANSCRIPT_EXTS } from "../parsers";
import { parseManifest, type ManifestRow } from "./manifest";
import type { CallSource, SourceCall } from "./types";

export const VIDEO_EXTS = [".webm", ".mp4", ".mkv", ".mov", ".m4a", ".mp3", ".wav"];

export async function sha256File(file: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export function slugify(s: string): string {
  return normName(s).replace(/ /g, "-");
}

/** "Reunião-01-Eli" → call_id "reuniao-01-eli", closer pelo alias que aparece no nome. */
export function inferFromFilename(base: string, team: Team): ManifestRow {
  const tokens = base.split(/[-_ .]+/).filter(Boolean);
  const closer = tokens
    .map((t) => matchPerson(team, t))
    .find((p) => p?.papeis.includes("closer"));
  const date = base.match(/(\d{4})[-_]?(\d{2})[-_]?(\d{2})/);
  return {
    call_id: slugify(base),
    closer: closer?.id,
    data_hora: date ? `${date[1]}-${date[2]}-${date[3]}` : undefined,
  };
}

/** Lê `data/inbox/`: pareia transcrição e vídeo pelo nome base e aplica o manifest.csv, se houver. */
export class LocalFolderSource implements CallSource {
  readonly name = "pasta-local";
  constructor(
    private dir: string,
    private team: Team,
  ) {}

  async list() {
    const warnings: string[] = [];
    const files = fs
      .readdirSync(this.dir)
      .map((f) => f.normalize("NFC"))
      .filter((f) => !f.startsWith("."));
    const groups = new Map<string, { transcript?: string; video?: string }>();
    for (const f of files) {
      const ext = path.extname(f).toLowerCase();
      const base = path.basename(f, path.extname(f));
      const g = groups.get(base) ?? {};
      if ((TRANSCRIPT_EXTS as readonly string[]).includes(ext)) g.transcript = f;
      else if (VIDEO_EXTS.includes(ext)) g.video = f;
      else continue;
      groups.set(base, g);
    }

    let manifest: ManifestRow[] = [];
    const manifestPath = path.join(this.dir, "manifest.csv");
    if (fs.existsSync(manifestPath)) {
      const res = parseManifest(fs.readFileSync(manifestPath, "utf8"));
      manifest = res.rows;
      warnings.push(...res.errors);
    }
    const byFile = (f?: string) =>
      f ? manifest.find((r) => r.transcricao?.normalize("NFC") === f || r.video?.normalize("NFC") === f) : undefined;

    const calls: SourceCall[] = [];
    for (const [base, g] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const inferred = inferFromFilename(base, this.team);
      const row = byFile(g.transcript) ?? byFile(g.video) ?? manifest.find((r) => r.call_id === inferred.call_id);
      const hashFile = g.transcript ?? g.video!;
      calls.push({
        call_id: row?.call_id ?? inferred.call_id,
        hash: await sha256File(path.join(this.dir, hashFile)),
        transcriptPath: g.transcript && path.join(this.dir, g.transcript),
        videoPath: g.video && path.join(this.dir, g.video),
        meta: row ? { ...inferred, ...row } : inferred,
        metaOrigem: row ? "manifest" : "nome_do_arquivo",
      });
    }
    return { calls, warnings };
  }

  async readTranscript(call: SourceCall) {
    if (!call.transcriptPath) throw new Error(`${call.call_id}: sem transcrição`);
    return fs.readFileSync(call.transcriptPath, "utf8");
  }
}
