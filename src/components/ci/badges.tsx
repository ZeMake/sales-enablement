import type { LucideIcon } from "lucide-react";
import { Dica } from "@/components/ci/dica";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { STATUS_LABEL, nota } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_STYLE: Record<string, string> = {
  ok: "bg-ok/15 text-ok ring-ok/30",
  atencao: "bg-warn/15 text-warn ring-warn/35",
  critica: "bg-crit/15 text-crit ring-crit/35",
};

export function StatusBadge({ status, className }: { status?: string | null; className?: string }) {
  if (!status) return <span className="font-mono text-[11px] text-muted-foreground">não analisada</span>;
  return (
    <span className={cn("inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 font-mono text-[10.5px] font-medium uppercase tracking-wider ring-1 ring-inset", STATUS_STYLE[status], className)}>
      <span className="size-1.5 rounded-full bg-current" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

/** Nota com cor relativa à barra mínima: abaixo = crítico, até +10 = atenção. */
export function Score({ value, barra, size = "md" }: { value?: number | null; barra: number; size?: "md" | "xl" }) {
  const tone = value == null ? "text-muted-foreground" : value < barra ? "text-crit" : value < barra + 10 ? "text-warn" : "text-ok";
  return (
    <span className={cn("font-heading tabular-nums", tone, size === "xl" ? "text-6xl leading-none" : "text-xl leading-none")}>
      {nota(value)}
    </span>
  );
}

const CHIP: Record<string, string> = {
  completo: "bg-ok",
  parcial: "bg-warn",
  ausente: "bg-muted-foreground/25",
};

export function StageChips({
  etapas,
  names,
}: {
  etapas: Array<{ id: string; status: string; nota?: number | null }>;
  names: Record<string, string>;
}) {
  return (
    <div className="flex items-center gap-[3px]">
      {etapas.map((e) => (
        <Tooltip key={e.id}>
          <TooltipTrigger asChild>
            <span className={cn("h-3.5 w-2.5 rounded-[2px]", CHIP[e.status] ?? "bg-muted")} aria-label={`${names[e.id] ?? e.id}: ${e.status}`} />
          </TooltipTrigger>
          <TooltipContent>
            {names[e.id] ?? e.id} · {e.status}
            {e.nota != null ? ` · ${Math.round(e.nota)}/10` : ""}
          </TooltipContent>
        </Tooltip>
      ))}
    </div>
  );
}

export function TalkBar({ closer, estimado }: { closer: number | null; estimado?: boolean }) {
  if (closer == null) return <span className="text-muted-foreground">—</span>;
  return (
    <div className="flex items-center gap-2" title={estimado ? "Tempo estimado (sem timestamps)" : undefined}>
      <div className="flex h-1.5 w-16 overflow-hidden rounded-full bg-lead/35">
        <div className={cn("h-full", closer > 0.65 ? "bg-crit" : "bg-closer")} style={{ width: `${Math.round(closer * 100)}%` }} />
      </div>
      <span className={cn("font-mono text-xs tabular-nums", closer > 0.65 && "text-crit")}>
        {Math.round(closer * 100)}%{estimado ? "*" : ""}
      </span>
    </div>
  );
}

export function Stat({ label, value, hint, tone, icon: Icon, dica }: { label: string; value: React.ReactNode; hint?: React.ReactNode; tone?: "crit" | "warn" | "ok"; icon?: LucideIcon; dica?: React.ReactNode }) {
  return (
    <div className="panel relative overflow-hidden p-5">
      <div className="flex items-center gap-2">
        {Icon && <Icon className="size-3.5 text-primary" strokeWidth={2.2} />}
        <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
        {dica && <Dica className="ml-auto">{dica}</Dica>}
      </div>
      <div className={cn("mt-3 font-heading text-[2.6rem] leading-none tabular-nums", tone === "crit" && "text-crit", tone === "warn" && "text-warn", tone === "ok" && "text-ok")}>{value}</div>
      {hint && <div className="mt-2.5 text-xs text-muted-foreground">{hint}</div>}
      {/* Linha de base no degradê da marca: dá unidade aos blocos de número. */}
      <div className="absolute inset-x-5 bottom-0 h-px bg-brand opacity-30" />
    </div>
  );
}
