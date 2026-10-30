import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { Score } from "@/components/ci/badges";
import { teamSummary } from "@/core/queries";
import { pct } from "@/lib/format";
import { getContext, resolvePlaybook } from "@/lib/server/context";

export const metadata = { title: "Closers" };

export default async function ClosersPage(props: PageProps<"/closers">) {
  const sp = await props.searchParams;
  const { db, viewer, barra } = await getContext();
  const playbook = await resolvePlaybook(sp.playbook);
  const t = await teamSummary(db, viewer, playbook, barra);
  return (
    <div className="space-y-5">
      <div>
        <div className="eyebrow">Time comercial</div>
        <h1 className="display mt-2 text-[2.6rem] md:text-5xl">Os <span className="text-brand">closers</span></h1>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {t.closers.map((c) => (
          <Link key={c.id} href={`/closers/${c.id}?playbook=${playbook}`} className="panel group p-5 transition-all hover:-translate-y-0.5 hover:border-primary/50">
            <div className="flex items-start gap-4">
              <span className="section-icon size-12 font-heading text-lg">{iniciais(c.nome)}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-lg font-semibold transition-colors group-hover:text-primary">{c.nome}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {c.calls} calls · <span className={c.criticas ? "text-crit" : undefined}>{c.criticas} crítica(s)</span>
                </div>
              </div>
              <Score value={c.nota_media} barra={barra} size="xl" />
            </div>
            <div className="mt-5 grid grid-cols-2 gap-5 text-sm">
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Abaixo da barra</div>
                <div className={cn("mt-1 font-heading text-2xl", (c.abaixo_pct ?? 0) > 0.3 ? "text-crit" : (c.abaixo_pct ?? 0) > 0 ? "text-warn" : "text-ok")}>{pct(c.abaixo_pct)}</div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", (c.abaixo_pct ?? 0) > 0.3 ? "bg-crit" : "bg-brand")} style={{ width: `${Math.round((c.abaixo_pct ?? 0) * 100)}%` }} />
                </div>
              </div>
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Fala média</div>
                <div className={cn("mt-1 font-heading text-2xl", (c.fala_media ?? 0) > 0.65 && "text-crit")}>{pct(c.fala_media)}</div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                  <div className={cn("h-full rounded-full", (c.fala_media ?? 0) > 0.65 ? "bg-crit" : "bg-brand")} style={{ width: `${Math.round((c.fala_media ?? 0) * 100)}%` }} />
                </div>
              </div>
            </div>
            <div className="mt-5 flex items-center justify-end gap-1 text-xs text-muted-foreground transition-colors group-hover:text-primary">
              Ver closer <ArrowRight className="size-3.5" />
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

const iniciais = (nome: string) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();
