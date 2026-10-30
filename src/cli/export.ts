/**
 * pnpm export:analyses [--call <id>]
 * Grava cada análise verificada em out/analises/<call>__<playbook>.json para revisão.
 */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { openDb } from "../core/db/client";
import { analyses } from "../core/db/schema";
import { loadEnv, option } from "./_shared";

async function main() {
  loadEnv();
  const db = await openDb();
  const callId = option(process.argv.slice(2), "call");
  const rows = callId
    ? await db.select().from(analyses).where(eq(analyses.call_id, callId)).all()
    : await db.select().from(analyses).all();
  const dir = "out/analises";
  fs.mkdirSync(dir, { recursive: true });
  for (const a of rows) {
    const { result, ...meta } = a;
    const file = path.join(dir, `${a.call_id}__${a.playbook_id}.json`);
    fs.writeFileSync(file, JSON.stringify({ meta, analise: result }, null, 2));
    console.log(file);
  }
  if (!rows.length) console.log("Nenhuma análise encontrada.");
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
