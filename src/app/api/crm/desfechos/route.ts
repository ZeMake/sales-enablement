import { loadConfig } from "@/core/config";
import { atualizarDesfechos, CrmApi } from "@/core/sources/crm-api";
import { iguais } from "@/lib/acesso";
import { db } from "@/lib/server/db";

export const maxDuration = 120;

/**
 * Cron diário da Vercel (vercel.json): atualiza ganho/perdido das calls a partir do CRM. A Vercel manda
 * `Authorization: Bearer $CRON_SECRET`; sem o segredo certo, nada roda.
 */
export async function GET(req: Request) {
  const segredo = process.env.CRON_SECRET ?? "";
  if (!segredo || !iguais(req.headers.get("authorization") ?? "", `Bearer ${segredo}`)) return new Response("Não autorizado", { status: 401 });
  if (!process.env.MAKECRM_API_KEY) return new Response("MAKECRM_API_KEY não configurada", { status: 503 });
  // Janela de 60 dias: cobre a venda que fecha semanas depois da call sem varrer o histórico todo.
  const desde = new Date(Date.now() - 60 * 864e5).toISOString().slice(0, 10);
  const mudaram = await atualizarDesfechos(await db(), new CrmApi(), loadConfig().team, desde);
  return Response.json({ desde, atualizados: mudaram.length, mudaram });
}
