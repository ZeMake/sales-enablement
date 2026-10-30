/**
 * pnpm media:web [--force]
 * Comprime o vídeo de cada call para a web (data/media-web/<nome-secreto>.mp4), pronto para
 * subir num armazenamento (Vercel Blob, R2…). Só roda no seu PC: nada é enviado.
 */
import fs from "node:fs";
import path from "node:path";
import { openDb } from "../core/db/client";
import { calls } from "../core/db/schema";
import { mediaKey, transcodeForWeb } from "../core/media";
import { flag, loadEnv } from "./_shared";

const OUT = "data/media-web";

async function main() {
  loadEnv();
  const force = flag(process.argv.slice(2), "force");
  const db = await openDb();
  const rows = (await db.select({ id: calls.id, media: calls.media_path }).from(calls)).filter((r) => r.media && !/^https?:/i.test(r.media) && fs.existsSync(r.media)); // vídeo por link fica no CRM
  let antes = 0, depois = 0;
  for (const [i, r] of rows.entries()) {
    const dest = path.join(OUT, mediaKey(r.id));
    antes += fs.statSync(r.media!).size;
    if (fs.existsSync(dest) && !force) {
      console.log(`[${i + 1}/${rows.length}] ${r.id}: já comprimido`);
    } else {
      process.stdout.write(`[${i + 1}/${rows.length}] ${r.id}… `);
      const t0 = Date.now();
      await transcodeForWeb(r.media!, dest + ".tmp.mp4");
      fs.renameSync(dest + ".tmp.mp4", dest);
      console.log(`${(fs.statSync(dest).size / 1e6).toFixed(1)} MB em ${Math.round((Date.now() - t0) / 1000)}s`);
    }
    depois += fs.statSync(dest).size;
  }
  console.log(`\n${rows.length} vídeo(s): ${(antes / 1e9).toFixed(2)} GB → ${(depois / 1e6).toFixed(0)} MB em ${OUT}/`);
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
