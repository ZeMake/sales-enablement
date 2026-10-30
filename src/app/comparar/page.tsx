import { ArrowRight, Columns3, ListChecks } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { SectionTitle } from "@/components/ci/section";
import { UrlSelect } from "@/components/ci/url-select";
import { compareClosers, type CloserComparison } from "@/core/queries";
import { pct } from "@/lib/format";
import { getContext, resolvePlaybook } from "@/lib/server/context";
import { cn } from "@/lib/utils";

export const metadata = { title: "Comparar closers" };

/** Abaixo disso, a diferença entre closers é mais provavelmente ruído do que habilidade. */
const AMOSTRA_MINIMA = 10;

type Metrica = {
  label: string;
  dica: string;
  valor: (c: CloserComparison) => number | null;
  mostrar: (c: CloserComparison) => React.ReactNode;
  melhor: "maior" | "menor" | null; // null = informativo, sem "melhor"
};

/** O "melhor" compara o valor como aparece na tela: 63 e 63 empatam, mesmo que por trás sejam 63,3 e 62,5. */
const r2 = (v: number | null) => (v == null ? null : Math.round(v * 100) / 100);

const METRICAS: Metrica[] = [
  { label: "Nota média", dica: "pelo status das etapas (0–100)", valor: (c) => (c.nota_media == null ? null : Math.round(c.nota_media)), mostrar: (c) => (c.nota_media == null ? "—" : Math.round(c.nota_media)), melhor: "maior" },
  { label: "Abaixo da barra", dica: "% das calls com nota abaixo da barra — a métrica principal", valor: (c) => r2(c.abaixo_pct), mostrar: (c) => pct(c.abaixo_pct), melhor: "menor" },
  { label: "Calls críticas", dica: "nota abaixo da barra ou churn vermelho confirmado", valor: (c) => c.criticas, mostrar: (c) => c.criticas, melhor: "menor" },
  { label: "Calls com churn vermelho", dica: "promessa de risco que a segunda opinião não contestou", valor: (c) => c.churn_vermelho_calls, mostrar: (c) => c.churn_vermelho_calls, melhor: "menor" },
  { label: "Fala do closer", dica: "% do tempo de fala (estimado); o playbook quer o lead falando mais", valor: (c) => r2(c.fala_media), mostrar: (c) => pct(c.fala_media), melhor: "menor" },
  { label: "Perguntas por call", dica: "contagem por interrogação", valor: (c) => (c.perguntas_media == null ? null : Math.round(c.perguntas_media)), mostrar: (c) => (c.perguntas_media == null ? "—" : Math.round(c.perguntas_media)), melhor: "maior" },
  {
    label: "Conversão",
    dica: "ganhas / calls com ganho ou perda registrado",
    valor: (c) => (c.conversao.com_desfecho ? r2(c.conversao.ganhas / c.conversao.com_desfecho) : null),
    mostrar: (c) => (c.conversao.com_desfecho ? `${pct(c.conversao.ganhas / c.conversao.com_desfecho)} (${c.conversao.ganhas}/${c.conversao.com_desfecho})` : "—"),
    melhor: "maior",
  },
  { label: "Notas provisórias", dica: "calls com etapa em revisão (as duas avaliações discordam)", valor: (c) => c.provisorias, mostrar: (c) => c.provisorias, melhor: null },
];

/** Índices dos closers com o melhor valor da linha (empate destaca todos; sem dados, nenhum). */
function melhores(cs: CloserComparison[], m: Metrica): Set<number> {
  if (!m.melhor) return new Set();
  const vals = cs.map(m.valor);
  const validos = vals.filter((v): v is number => v != null);
  if (validos.length < 2) return new Set();
  const alvo = m.melhor === "maior" ? Math.max(...validos) : Math.min(...validos);
  if (validos.every((v) => v === alvo)) return new Set();
  return new Set(vals.flatMap((v, i) => (v === alvo ? [i] : [])));
}

const iniciais = (nome: string) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]).join("").toUpperCase();

export default async function CompararPage(props: PageProps<"/comparar">) {
  const sp = await props.searchParams;
  const { db, viewer, barra, playbooks } = await getContext();
  const playbook = await resolvePlaybook(sp.playbook);
  const pb = playbooks.find((p) => p.id === playbook)!;
  const cs = await compareClosers(db, viewer, playbook, barra);
  const amostraPequena = cs.some((c) => c.analisadas < AMOSTRA_MINIMA);
  const grid = { gridTemplateColumns: `minmax(180px, 1.3fr) repeat(${Math.max(cs.length, 1)}, minmax(120px, 1fr))` };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Time comercial · {pb.nome}</div>
          <h1 className="display mt-2 text-[2.6rem] md:text-5xl">
            Closers <span className="text-brand">lado a lado</span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            O destaque verde marca o melhor do time em cada linha. Use para achar quem ensina o quê: o closer forte numa etapa pode puxar o coaching dela.
          </p>
        </div>
        <Suspense>
          <UrlSelect param="playbook" placeholder="Playbook" fallback={playbook} options={playbooks.map((p) => ({ value: p.id, label: p.nome }))} className="w-[210px]" />
        </Suspense>
      </div>

      {amostraPequena && (
        <div className="rounded-xl border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
          <b>Amostra pequena.</b> Há closer com menos de {AMOSTRA_MINIMA} calls analisadas: diferenças de poucos pontos podem ser ruído, não habilidade. Use para conversar, não para ranquear.
        </div>
      )}

      {!cs.length ? (
        <p className="panel px-6 py-10 text-center text-sm text-muted-foreground">Nenhuma call analisada neste playbook.</p>
      ) : (
        <>
          {/* Cabeçalho das colunas: um card por closer */}
          <div className="grid gap-3" style={grid}>
            <div />
            {cs.map((c) => (
              <Link key={c.id} href={`/closers/${c.id}?playbook=${playbook}`} className="panel group flex items-center gap-3 p-3 transition-all hover:-translate-y-0.5 hover:border-primary/50">
                <span className="section-icon size-10 font-heading text-base">{iniciais(c.nome)}</span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold group-hover:text-primary">{c.nome}</div>
                  <div className="flex items-center gap-1 font-mono text-[10.5px] text-muted-foreground">
                    {c.analisadas} call(s) <ArrowRight className="size-3 opacity-0 transition-opacity group-hover:opacity-100" />
                  </div>
                </div>
              </Link>
            ))}
          </div>

          <section className="panel overflow-x-auto p-5">
            <SectionTitle icon={Columns3} title="Indicadores" aside="melhor do time em verde" />
            <div className="min-w-[640px] divide-y">
              {METRICAS.map((m) => {
                const best = melhores(cs, m);
                return (
                  <div key={m.label} className="grid items-center gap-3 py-2.5" style={grid}>
                    <div>
                      <div className="text-sm font-medium">{m.label}</div>
                      <div className="text-[11.5px] text-muted-foreground">{m.dica}</div>
                    </div>
                    {cs.map((c, i) => (
                      <div
                        key={c.id}
                        className={cn(
                          "rounded-lg px-3 py-2 text-center font-mono text-[15px] tabular-nums",
                          best.has(i) ? "bg-ok/12 font-semibold text-ok ring-1 ring-ok/35 ring-inset" : "bg-muted/40",
                        )}
                      >
                        {m.mostrar(c)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </section>

          <section className="panel overflow-x-auto p-5">
            <SectionTitle icon={ListChecks} title="Etapas do playbook" aside="% das calls com a etapa completa" />
            <div className="min-w-[640px] divide-y">
              {pb.etapas.map((e) => {
                const vals = cs.map((c) => r2(c.etapas[e.id]?.completo_pct ?? null));
                const validos = vals.filter((v): v is number => v != null);
                const topo = validos.length > 1 && !validos.every((v) => v === validos[0]) ? Math.max(...validos) : null;
                return (
                  <div key={e.id} className="grid items-center gap-3 py-2.5" style={grid}>
                    <div className="text-sm font-medium">{e.nome}</div>
                    {cs.map((c, i) => {
                      const st = c.etapas[e.id];
                      const v = vals[i];
                      return (
                        <div
                          key={c.id}
                          className={cn("rounded-lg px-3 py-2 text-center", topo != null && v === topo && "ring-1 ring-ok/50 ring-inset")}
                          // Mapa de calor numa cor só (laranja da marca): mais escuro = mais vezes completa.
                          style={{ background: v == null ? undefined : `oklch(0.74 0.185 55 / ${0.06 + v * 0.42})` }}
                          title={st ? `${Math.round(v! * 100)}% completa em ${st.n} call(s) · média ${st.pontos_medios.toFixed(1)}/10` : "sem dados"}
                        >
                          <div className={cn("font-mono text-[15px] tabular-nums", topo != null && v === topo && "font-semibold text-ok")}>{v == null ? "—" : pct(v)}</div>
                          {st && <div className="font-mono text-[10.5px] text-muted-foreground">{st.pontos_medios.toFixed(1)} pts</div>}
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
