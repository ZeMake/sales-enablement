/**
 * pnpm deploy:prepare
 * Monta o que a versão publicada (só leitura) leva junto, sem tocar no git:
 *  - snapshot/app.db: cópia consistente do banco (backup do SQLite, não cópia de arquivo em uso);
 *  - public/videos/: vídeos comprimidos (pnpm media:web) por hardlink — não ocupa espaço extra.
 * Calls por link do CRM não precisam de nada: o player toca do próprio link.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { loadEnv } from "./_shared";

loadEnv();
const db = process.env.DATABASE_PATH ?? "data/app.db";
fs.mkdirSync("snapshot", { recursive: true });
fs.rmSync("snapshot/app.db", { force: true });
execFileSync("sqlite3", [db, ".backup snapshot/app.db"]);
console.log(`Banco: ${db} → snapshot/app.db (${(fs.statSync("snapshot/app.db").size / 1e6).toFixed(1)} MB)`);

const origem = "data/media-web";
const destino = "public/videos";
fs.rmSync(destino, { recursive: true, force: true });
fs.mkdirSync(destino, { recursive: true });
const videos = fs.existsSync(origem) ? fs.readdirSync(origem).filter((f) => f.endsWith(".mp4") && !f.includes(".tmp.")) : [];
let total = 0;
for (const f of videos) {
  try {
    fs.linkSync(path.join(origem, f), path.join(destino, f));
  } catch {
    fs.copyFileSync(path.join(origem, f), path.join(destino, f));
  }
  total += fs.statSync(path.join(destino, f)).size;
}
console.log(`Vídeos: ${videos.length} em ${destino}/ (${(total / 1e6).toFixed(0)} MB, hardlink: sem espaço extra)`);
if (!videos.length) console.log("Nenhum vídeo comprimido: rode antes pnpm media:web");
