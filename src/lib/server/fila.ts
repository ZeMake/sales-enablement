import "server-only";
import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Como a fila roda:
 * - local (padrão): `pnpm jobs` num processo separado, pela assinatura do Claude no PC;
 * - vercel (JOBS_MODE=vercel): um passo por chamada da rota /api/fila, que dispara a seguinte.
 */
export const modoFila = () => (process.env.JOBS_MODE === "vercel" ? "vercel" : "local");

export function dispararFila(origem?: string) {
  if (modoFila() === "vercel") return dispararPasso(origem);
  const tsx = path.join(process.cwd(), "node_modules", ".bin", "tsx");
  spawn(tsx, ["src/cli/jobs.ts"], { cwd: process.cwd(), detached: true, stdio: "ignore", env: process.env }).unref();
}

/** Chama /api/fila (responde na hora; o passo roda em segundo plano lá). */
export async function dispararPasso(origem?: string) {
  const base = (process.env.APP_URL ?? origem ?? "").replace(/\/$/, "");
  const segredo = process.env.JOB_SECRET;
  if (!base || !segredo) throw new Error("APP_URL e JOB_SECRET precisam estar definidos para a fila na Vercel");
  await fetch(`${base}/api/fila`, { method: "POST", headers: { "x-fila-segredo": segredo } }).catch(() => undefined);
}
