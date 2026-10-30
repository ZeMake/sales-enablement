import { CallMetaSchema, type CallMeta } from "../types";

export const MANIFEST_COLUMNS = [
  "call_id", "transcricao", "video", "closer", "gestor", "data_hora", "lead_nome", "empresa",
  "produto", "tipo_call", "desfecho", "valor_venda", "crm_url", "obs",
] as const;

export type ManifestRow = CallMeta & { transcricao?: string; video?: string };

/** CSV RFC 4180 (aspas, vírgula ou ponto e vírgula como separador). */
export function parseCsv(content: string): string[][] {
  const text = content.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  const sep = (firstLine.match(/;/g)?.length ?? 0) > (firstLine.match(/,/g)?.length ?? 0) ? ";" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === sep) { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f.trim())) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim())) rows.push(row);
  return rows;
}

/** Valor BR ou US: "R$ 12.500,00", "12500.5". */
export function parseMoney(v: string): number | undefined {
  const s = v.replace(/[R$\s]/g, "");
  if (!s) return undefined;
  const normalized = /,\d{1,2}$/.test(s) ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  const n = Number(normalized);
  return Number.isFinite(n) ? n : undefined;
}

export function parseManifest(content: string): { rows: ManifestRow[]; errors: string[] } {
  const [header, ...lines] = parseCsv(content);
  if (!header) return { rows: [], errors: [] };
  const cols = header.map((h) => h.trim().toLowerCase());
  const rows: ManifestRow[] = [];
  const errors: string[] = [];
  lines.forEach((line, i) => {
    const rec: Record<string, unknown> = {};
    cols.forEach((c, j) => {
      const v = line[j]?.trim();
      if (v) rec[c] = c === "valor_venda" ? parseMoney(v) : v;
    });
    const parsed = CallMetaSchema.safeParse(rec);
    if (!parsed.success) {
      errors.push(`manifest linha ${i + 2}: ${parsed.error.issues.map((x) => `${x.path.join(".")}: ${x.message}`).join("; ")}`);
      return;
    }
    rows.push({ ...parsed.data, transcricao: rec.transcricao as string, video: rec.video as string });
  });
  return { rows, errors };
}

const esc = (v: unknown) => {
  const s = v === undefined || v === null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toManifestCsv(rows: ManifestRow[]): string {
  const lines = [MANIFEST_COLUMNS.join(",")];
  for (const r of rows) lines.push(MANIFEST_COLUMNS.map((c) => esc((r as Record<string, unknown>)[c])).join(","));
  return lines.join("\n") + "\n";
}
