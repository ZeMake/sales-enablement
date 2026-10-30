import fs from "node:fs";
import { openDb } from "../core/db/client";

export function loadEnv() {
  try {
    process.loadEnvFile(".env");
  } catch {
    // sem .env: segue com o ambiente atual
  }
}

export function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

export function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Tabela simples para terminal, com largura por coluna. */
export function table(headers: string[], rows: string[][]): string {
  const w = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (c ?? "").padEnd(w[i])).join("  ");
  return [line(headers), w.map((n) => "─".repeat(n)).join("  "), ...rows.map(line)].join("\n");
}

export const pct = (n: number) => `${Math.round(n * 100)}%`;

export function mmss(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** URL e token do banco publicado (Turso), de .env.vercel (`npx vercel env pull .env.vercel --environment production`). */
export function lerEnvVercel(): { url: string; authToken?: string } {
  if (!fs.existsSync(".env.vercel")) throw new Error("Rode antes: npx vercel env pull .env.vercel --environment production");
  const env = Object.fromEntries(
    fs.readFileSync(".env.vercel", "utf8").split("\n").flatMap((l) => {
      const m = l.match(/^([A-Z0-9_]+)="?(.*?)"?$/);
      return m ? [[m[1], m[2]]] : [];
    }),
  );
  const url = env.DATABASE_URL || env.TURSO_DATABASE_URL;
  if (!url) throw new Error(".env.vercel sem TURSO_DATABASE_URL: o banco do Turso já foi ligado ao projeto?");
  return { url, authToken: env.DATABASE_AUTH_TOKEN || env.TURSO_AUTH_TOKEN };
}

/** Banco local, ou o publicado (Turso) com --publicado: grava direto na versão do time, sem db:push. */
export function abrirBanco(args: string[]) {
  return flag(args, "publicado") ? openDb(undefined, lerEnvVercel()) : openDb();
}
