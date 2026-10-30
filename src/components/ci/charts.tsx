"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

const axis = { stroke: "var(--muted-foreground)", fontSize: 11, tickLine: false, axisLine: false } as const;
const tip = {
  contentStyle: { background: "var(--popover)", border: "1px solid var(--border)", borderRadius: 6, fontSize: 12, color: "var(--popover-foreground)" },
  cursor: { fill: "var(--muted)", opacity: 0.4 },
} as const;

/** Evolução da nota com a barra mínima como referência. */
export function ScoreTrend({ data, barra }: { data: Array<{ label: string; nota: number }>; barra: number }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 10, right: 12, bottom: 0, left: -18 }}>
        <CartesianGrid stroke="var(--border)" vertical={false} />
        <XAxis dataKey="label" {...axis} />
        <YAxis domain={[0, 100]} {...axis} />
        <Tooltip {...tip} />
        <ReferenceLine y={barra} stroke="var(--crit)" strokeDasharray="4 4" label={{ value: `barra ${barra}`, fill: "var(--crit)", fontSize: 10, position: "insideTopRight" }} />
        <Line isAnimationActive={false} type="monotone" dataKey="nota" stroke="var(--primary)" strokeWidth={2.5} dot={{ r: 4, fill: "var(--primary)" }} activeDot={{ r: 6 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

/** Cobertura por etapa: completo / parcial / ausente empilhados (HTML, sem medir container). */
export function StageCoverage({ data }: { data: Array<{ etapa: string; completo: number; parcial: number; ausente: number }> }) {
  return (
    <div className="space-y-2.5">
      {data.map((d) => {
        const total = d.completo + d.parcial + d.ausente || 1;
        const seg = (n: number, cls: string, label: string) =>
          n > 0 && <div className={cls} style={{ width: `${(n / total) * 100}%` }} title={`${label}: ${n}`} />;
        return (
          <div key={d.etapa} className="grid grid-cols-[150px_1fr_auto] items-center gap-3 text-sm">
            <span className="truncate" title={d.etapa}>{d.etapa}</span>
            <div className="flex h-3 overflow-hidden rounded-sm bg-muted">
              {seg(d.completo, "bg-ok", "completo")}
              {seg(d.parcial, "bg-warn", "parcial")}
              {seg(d.ausente, "bg-muted-foreground/30", "ausente")}
            </div>
            <span className="w-16 text-right font-mono text-[11px] text-muted-foreground">
              {d.completo}·{d.parcial}·{d.ausente}
            </span>
          </div>
        );
      })}
      <div className="flex gap-4 pt-1 font-mono text-[10.5px] text-muted-foreground">
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-ok" />completo</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-warn" />parcial</span>
        <span className="flex items-center gap-1.5"><span className="size-2 rounded-sm bg-muted-foreground/30" />ausente</span>
      </div>
    </div>
  );
}

/** % de calls abaixo da barra por closer (métrica principal do gestor). */
export function BelowBar({ data }: { data: Array<{ nome: string; abaixo: number; n: number }> }) {
  if (!data.length) return <p className="text-sm text-muted-foreground">Nenhuma call analisada neste playbook.</p>;
  return (
    <div className="space-y-3">
      {data.map((d) => (
        <div key={d.nome} className="grid grid-cols-[140px_1fr_auto] items-center gap-3 text-sm">
          <span className="truncate font-medium">{d.nome}</span>
          <div className="h-5 overflow-hidden rounded-sm bg-muted">
            <div className="h-full bg-crit/85" style={{ width: `${d.abaixo}%` }} />
          </div>
          <span className="w-24 text-right font-mono text-xs">
            <b className="text-crit">{d.abaixo}%</b> <span className="text-muted-foreground">de {d.n}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
