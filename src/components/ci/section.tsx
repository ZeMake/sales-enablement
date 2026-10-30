import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Título de seção de card: ícone no círculo laranja + rótulo em caixa alta; `aside` à direita. */
export function SectionTitle({ icon: Icon, title, aside, className }: { icon: LucideIcon; title: React.ReactNode; aside?: React.ReactNode; className?: string }) {
  return (
    <div className={cn("mb-4 flex items-center gap-3", className)}>
      <span className="section-icon">
        <Icon className="size-4" strokeWidth={2.2} />
      </span>
      <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.16em]">{title}</h2>
      {aside && <div className="ml-auto text-right font-mono text-[10.5px] text-muted-foreground">{aside}</div>}
    </div>
  );
}

/**
 * Cabeçalho de página: rótulo, título grande com a parte final no degradê da marca, subtítulo e ações.
 * `title` é a parte neutra, `accent` a parte laranja.
 */
export function PageHeader({
  eyebrow,
  title,
  accent,
  subtitle,
  actions,
}: {
  eyebrow?: React.ReactNode;
  title: React.ReactNode;
  accent?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1 className="display mt-2 text-[2.6rem] md:text-5xl">
          {title} {accent && <span className="text-brand">{accent}</span>}
        </h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap justify-end gap-2 max-lg:w-full">{actions}</div>}
    </div>
  );
}

/** Divide um nome em parte neutra + última palavra (que vai para o degradê). */
export function splitAccent(text: string): { title: string; accent?: string } {
  const parts = text.trim().split(/\s+/);
  if (parts.length < 2) return { title: "", accent: text };
  return { title: parts.slice(0, -1).join(" "), accent: parts.at(-1) };
}
