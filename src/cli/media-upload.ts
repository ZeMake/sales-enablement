/**
 * pnpm media:upload
 * Sobe os vídeos comprimidos (data/media-web/, gerados pelo pnpm media:web) para o Vercel Blob como
 * PRIVADOS. O painel publicado gera links assinados que expiram (MEDIA_STORAGE=blob na Vercel).
 * Precisa de BLOB_READ_WRITE_TOKEN no .env (Vercel → Storage → Blob → o store do projeto).
 * Os nomes também são secretos (derivados do MEDIA_KEY_SALT), como segunda trava.
 */
import fs from "node:fs";
import path from "node:path";
import { head, put } from "@vercel/blob";
import { loadEnv } from "./_shared";

const DIR = "data/media-web";

async function main() {
  loadEnv();
  if (!process.env.BLOB_READ_WRITE_TOKEN) throw new Error("Defina BLOB_READ_WRITE_TOKEN no .env (Vercel → Storage → Blob)");
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith(".mp4") && !f.includes(".tmp.")) : [];
  if (!files.length) throw new Error(`Nada em ${DIR}/. Rode antes: pnpm media:web`);
  for (const [i, f] of files.entries()) {
    const nome = `videos/${f}`;
    const ja = await head(nome).catch(() => null);
    if (ja) {
      console.log(`[${i + 1}/${files.length}] ${f}: já está no Blob`);
      continue;
    }
    process.stdout.write(`[${i + 1}/${files.length}] ${f} (${(fs.statSync(path.join(DIR, f)).size / 1e6).toFixed(1)} MB)… `);
    await put(nome, fs.createReadStream(path.join(DIR, f)), { access: "private", addRandomSuffix: false, contentType: "video/mp4", multipart: true });
    console.log("ok");
  }
  console.log("\nPronto. Na Vercel, defina MEDIA_STORAGE=blob e MEDIA_KEY_SALT (o mesmo valor do seu .env).");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
