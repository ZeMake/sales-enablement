import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate } from "drizzle-orm/libsql/migrator";
import * as schema from "./schema";

export type Db = Awaited<ReturnType<typeof openDb>>;

/**
 * libSQL: o mesmo driver serve para arquivo local (padrão) e para Turso hospedado
 * (DATABASE_URL=libsql://… + DATABASE_AUTH_TOKEN), o que permite subir o painel depois.
 */
export async function openDb(file = process.env.DATABASE_PATH ?? "data/app.db", opts: { url?: string; authToken?: string } = {}) {
  // Banco hospedado: variáveis próprias ou as que a integração do Turso na Vercel cria.
  const remote = opts.url ?? process.env.DATABASE_URL ?? process.env.TURSO_DATABASE_URL;
  const authToken = opts.authToken ?? process.env.DATABASE_AUTH_TOKEN ?? process.env.TURSO_AUTH_TOKEN;
  // Versão publicada (só leitura): a cópia do banco vai junto no deploy (DB_SNAPSHOT) e é aberta em
  // /tmp, a única pasta gravável da função. Nada do que for gravado ali sobrevive: por isso READ_ONLY.
  const snapshot = process.env.DB_SNAPSHOT;
  if (!remote && snapshot) {
    const tmp = path.join(os.tmpdir(), "sales-enablement.db");
    // Caminho preso à pasta snapshot/: um caminho 100% dinâmico faz o build da Vercel empacotar o
    // projeto inteiro (inclusive os vídeos de public/) em cada função.
    if (!fs.existsSync(tmp)) fs.copyFileSync(path.join(process.cwd(), "snapshot", path.basename(snapshot)), tmp);
    file = tmp;
  }
  if (!remote) fs.mkdirSync(path.dirname(file), { recursive: true });
  const client = createClient(
    remote ? { url: remote, authToken } : { url: `file:${file}` },
  );
  await client.execute("PRAGMA foreign_keys = ON");
  const db = drizzle(client, { schema, casing: "snake_case" });
  await migrate(db, { migrationsFolder: path.join(process.cwd(), "drizzle") });
  return db;
}
