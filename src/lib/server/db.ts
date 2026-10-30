import "server-only";
import { openDb, type Db } from "@/core/db/client";
import * as schema from "@/core/db/schema";

// Uma conexão por processo (o dev server recarrega módulos; guarda no globalThis).
// Se o schema mudar (coluna nova + migração), o dev server recarrega o módulo do schema e a conexão
// é refeita: o Drizzle guarda em cache os nomes das colunas por tabela e, com a conexão antiga,
// colunas novas saem como `undefined` ("Cannot read properties of undefined (reading 'replace')").
const g = globalThis as unknown as { __ciDb?: Promise<Db>; __ciSchema?: unknown };

export function db(): Promise<Db> {
  if (!g.__ciDb || g.__ciSchema !== schema) {
    g.__ciDb = openDb();
    g.__ciSchema = schema;
  }
  return g.__ciDb;
}
