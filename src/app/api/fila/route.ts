import { after } from "next/server";
import { loadConfig } from "@/core/config";
import { destravar, processStep, proximoJob, travar } from "@/core/jobs";
import { iguais } from "@/lib/acesso";
import { db } from "@/lib/server/db";
import { dispararPasso } from "@/lib/server/fila";

// Cada passo (uma análise) leva 2–3 min: cabe nos 300 s da Vercel (plano Hobby).
export const maxDuration = 300;

/**
 * Executa UM passo da fila e encadeia o próximo. Protegido por segredo próprio (não pelo cookie):
 * só o próprio servidor chama esta rota.
 */
export async function POST(req: Request) {
  const segredo = process.env.JOB_SECRET ?? "";
  if (!segredo || !iguais(req.headers.get("x-fila-segredo") ?? "", segredo)) return new Response("Não autorizado", { status: 401 });
  after(async () => {
    const conn = await db();
    const job = await proximoJob(conn);
    if (!job || !(await travar(conn, job.id))) return; // nada a fazer, ou outro passo já está nele
    let continua = false;
    try {
      ({ continua } = await processStep(conn, loadConfig(), job));
    } finally {
      await destravar(conn, job.id);
    }
    if (continua || (await proximoJob(conn))) await dispararPasso();
  });
  return new Response(null, { status: 202 });
}
