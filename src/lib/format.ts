export const pct = (n: number | null | undefined, digits = 0) =>
  n == null ? "—" : `${(n * 100).toFixed(digits)}%`;

export const nota = (n: number | null | undefined) => (n == null ? "—" : String(Math.round(n)));

export function mmss(sec: number | null | undefined): string {
  if (sec == null || !Number.isFinite(sec)) return "—";
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export function dataCurta(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T12:00:00` : iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short" });
}

export const DESFECHO_LABEL: Record<string, string> = {
  ganho: "Ganho",
  perdido: "Perdido",
  em_andamento: "Em andamento",
  no_show: "No-show",
};

export const STATUS_LABEL: Record<string, string> = { ok: "OK", atencao: "Atenção", critica: "Crítica" };

export const OBJECAO_LABEL: Record<string, string> = {
  preco: "Preço", tempo: "Tempo", confianca: "Confiança", decisor: "Decisor",
  concorrente: "Concorrente", necessidade: "Necessidade", outro: "Outro",
};

export const humanize = (s: string) => s.replace(/_/g, " ");
