import { BarChart3, BookOpen, HeartHandshake, ListChecks, Medal, ScanSearch, ShieldAlert, Siren, TrendingDown, Trophy } from "lucide-react";
import { Dica } from "@/components/ci/dica";
import { dicas } from "@/lib/dicas";
import { SectionTitle } from "@/components/ci/section";
import Link from "next/link";
import { Suspense } from "react";
import { Score, Stat, StatusBadge } from "@/components/ci/badges";
import { BelowBar } from "@/components/ci/charts";
import { UrlSelect } from "@/components/ci/url-select";
import { teamSummary } from "@/core/queries";
import { dataCurta, pct } from "@/lib/format";
import { cn } from "@/lib/utils";
import { getContext, resolvePlaybook } from "@/lib/server/context";

export const metadata = { title: "Time" };

export default async function TeamPage(props: PageProps<"/time">) {
  const sp = await props.searchParams;
  const { db, viewer, barra, playbooks, stageName } = await getContext();
  const playbook = await resolvePlaybook(sp.playbook);
  const periodo = (Array.isArray(sp.periodo) ? sp.periodo[0] : sp.periodo) ?? "tudo";
  const desde = periodo === "semana" ? seteDiasAtras() : undefined;
  const t = await teamSummary(db, viewer, playbook, barra, desde);
  const pb = playbooks.find((p) => p.id === playbook)!;
  const etapaDe = (id: string) => pb.etapas.find((e) => e.id === id);
  const pior = t.etapas[0];
  const nAnalisadas = t.closers.reduce((a, c) => a + c.analisadas, 0);
  const d = dicas();
  // Destaques só com amostra mínima: com 2–3 calls um closer "vira" o melhor por acaso.
  const elegiveis = [...t.closers].filter((c) => c.analisadas >= MIN_CALLS_DESTAQUE && c.nota_media != null).sort((a, b) => b.nota_media! - a.nota_media! || (a.abaixo_pct ?? 0) - (b.abaixo_pct ?? 0));
  const melhor = elegiveis.length >= 2 ? elegiveis[0] : undefined;
  const atencao = elegiveis.length >= 2 ? elegiveis[elegiveis.length - 1] : undefined;
  const abaixoTime = nAnalisadas ? t.closers.reduce((a, c) => a + (c.abaixo_pct ?? 0) * c.analisadas, 0) / nAnalisadas : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Visão do gestor · {pb.nome}</div>
          <h1 className="display mt-2 text-[2.6rem] md:text-5xl">
            O time <span className="text-brand">abaixo da barra</span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Aderência é piso, não teto: o que importa é tirar gente da faixa ruim. Nota 7 converte quase igual a nota 10.
          </p>
        </div>
        <Suspense>
          <div className="flex gap-2">
            <UrlSelect param="playbook" placeholder="Playbook" fallback={playbook} options={playbooks.map((p) => ({ value: p.id, label: p.nome }))} className="w-[210px]" />
            <UrlSelect param="periodo" placeholder="Período" fallback="tudo" options={[{ value: "tudo", label: "Todo o período" }, { value: "semana", label: "Últimos 7 dias" }]} className="w-[160px]" />
          </div>
        </Suspense>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={TrendingDown} label="Calls abaixo da barra" value={pct(abaixoTime)} tone={abaixoTime == null ? undefined : abaixoTime > 0.3 ? "crit" : "ok"} hint={`barra mínima ${barra} (provisória)`} dica={`% das calls analisadas com nota abaixo de ${barra}. É a métrica principal do time: a meta é derrubar esse número.`} />
        <Stat icon={ListChecks} label="Etapa que mais falha" value={<span className="text-3xl">{pior ? stageName(playbook, pior.id) : "—"}</span>} hint={pior ? `${pct(pior.falha_pct)} das calls sem completar · nota média ${pior.nota_media.toFixed(1)}` : undefined} />
        <Stat icon={ShieldAlert} label="Calls com churn vermelho" value={t.churn.length} tone={t.churn.length ? "crit" : "ok"} hint={periodo === "semana" ? "últimos 7 dias" : "todo o período"} dica={d.churn + " " + d.churn_vermelho} />
        <Stat icon={ScanSearch} label="Analisadas" value={`${t.analisadas}/${t.total}`} hint="calls comerciais com análise neste playbook" />
      </div>

      {melhor && atencao && melhor.id !== atencao.id && (
        <div className="grid gap-4 md:grid-cols-2">
          <Destaque tipo="melhor" c={melhor} playbook={playbook} barra={barra} etapaNome={(id) => stageName(playbook, id)} pergunta={undefined} />
          <Destaque tipo="atencao" c={atencao} playbook={playbook} barra={barra} etapaNome={(id) => stageName(playbook, id)} pergunta={etapaDe(atencao.etapas.at(-1)?.id ?? "")?.perguntas_exemplo[0]} />
        </div>
      )}

      <div className="grid items-start gap-5 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-5">
          <section className="panel p-5">
            <SectionTitle icon={BarChart3} title="% de calls abaixo da barra por closer" className="mb-2" />
            <p className="mb-3 text-xs text-muted-foreground">A métrica principal: quem mais precisa de coaching agora.</p>
            <BelowBar data={t.closers.filter((c) => c.abaixo_pct != null).map((c) => ({ nome: c.nome, abaixo: Math.round(c.abaixo_pct! * 100), n: c.analisadas }))} />
          </section>
          <section className="panel p-5">
            <SectionTitle icon={Trophy} title="Ranking" aside={<Dica>Ordenado pela nota média das calls analisadas neste playbook. &quot;Abaixo&quot; = % das calls com nota abaixo de {barra}. &quot;Fala&quot; = quanto do tempo o closer falou, em média (o ideal é abaixo de {d.fala}%). &quot;Vendas&quot; = ganhas / com desfecho registrado.</Dica>} />
            <table className="w-full text-sm">
              <thead className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
                <tr className="text-left">
                  <th className="pb-2">Closer</th>
                  <th className="pb-2 text-right">Calls</th>
                  <th className="pb-2 text-right">Abaixo</th>
                  <th className="pb-2 text-right">Fala</th>
                  <th className="pb-2 text-right">Vendas</th>
                  <th className="pb-2 text-right">Nota</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {[...t.closers].sort((a, b) => (b.nota_media ?? 0) - (a.nota_media ?? 0)).map((c, i) => (
                  <tr key={c.id}>
                    <td className="py-2">
                      <span className="mr-2 font-mono text-muted-foreground">{i + 1}</span>
                      <Link href={`/closers/${c.id}?playbook=${playbook}`} className="font-medium hover:text-primary">{c.nome}</Link>
                    </td>
                    <td className="text-right font-mono">{c.calls}</td>
                    <td className={cn("text-right font-mono", (c.abaixo_pct ?? 0) > 0.3 ? "text-crit" : (c.abaixo_pct ?? 0) > 0 ? "text-warn" : "text-ok")}>{pct(c.abaixo_pct)}</td>
                    <td className={cn("text-right font-mono", (c.fala_media ?? 0) * 100 > d.fala && "text-crit")}>{pct(c.fala_media)}</td>
                    <td className="text-right font-mono">{c.com_desfecho ? `${c.ganhas}/${c.com_desfecho}` : "—"}</td>
                    <td className="text-right"><Score value={c.nota_media} barra={barra} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
        <section className="panel p-5">
          <SectionTitle icon={TrendingDown} title="Onde o time falha" aside="% das calls sem a etapa completa" />
          <div className="space-y-2.5">
            {t.etapas.map((e) => (
              <div key={e.id} className="flex items-center gap-3 text-sm">
                <div className="w-56 min-w-0">
                  <div className="truncate">{stageName(playbook, e.id)}</div>
                  {/* A pergunta que a etapa responde: ajuda a ler o gráfico sem decorar o playbook. */}
                  {etapaDe(e.id)?.em_uma_frase && <div className="text-[11.5px] leading-snug text-muted-foreground">{etapaDe(e.id)!.em_uma_frase}</div>}
                </div>
                <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-warn" style={{ width: `${Math.round(e.falha_pct * 100)}%` }} />
                </div>
                <span className="w-10 text-right font-mono text-xs">{pct(e.falha_pct)}</span>
              </div>
            ))}
          </div>
        </section>
      </div>

      <LegendaEtapas etapas={pb.etapas} falha={Object.fromEntries(t.etapas.map((e) => [e.id, e.falha_pct]))} playbook={pb.nome} soLead={pb.evidencia_do_lead_obrigatoria} />

      <div className="grid gap-5 lg:grid-cols-2">
        <CallList title="Calls críticas para revisar" items={t.criticas.slice(0, 8)} playbook={playbook} barra={barra} />
        <CallList title="Calls com churn vermelho" items={t.churn} playbook={playbook} barra={barra} churn />
      </div>
    </div>
  );
}

function CallList({ title, items, playbook, barra, churn }: { title: string; items: Awaited<ReturnType<typeof teamSummary>>["criticas"]; playbook: string; barra: number; churn?: boolean }) {
  return (
    <section className="panel overflow-hidden">
      <SectionTitle icon={Siren} title={title} className="px-5 pt-5 mb-3" />
      <div className="divide-y">
        {items.map((c) => (
          <Link key={c.id} href={`/calls/${c.id}?playbook=${playbook}`} className="block px-4 py-3 hover:bg-secondary/60">
            <div className="flex items-center gap-3">
              <span className="w-16 shrink-0 whitespace-nowrap font-mono text-xs text-muted-foreground">{dataCurta(c.data)}</span>
              <span className="flex-1 truncate font-medium">{c.lead}</span>
              <span className="text-sm text-muted-foreground">{c.closer_nome}</span>
              <Score value={c.analysis?.nota} barra={barra} />
              {churn ? <span className="rounded bg-crit/15 px-1.5 py-0.5 font-mono text-[11px] text-crit">×{c.analysis?.churn_vermelho}</span> : <StatusBadge status={c.analysis?.classificacao} />}
            </div>
            {!churn && c.analysis?.motivos[0] && <p className="mt-1 pl-[68px] text-xs text-muted-foreground">{c.analysis.motivos[0]}</p>}
          </Link>
        ))}
        {!items.length && <p className="px-4 py-6 text-sm text-muted-foreground">Nada aqui. 🎉</p>}
      </div>
    </section>
  );
}

const MIN_CALLS_DESTAQUE = 5;

type CloserResumo = Awaited<ReturnType<typeof teamSummary>>["closers"][number];

/** Card de destaque: quem está indo melhor e quem precisa de coaching, com o porquê em frase. */
function Destaque({ tipo, c, playbook, barra, etapaNome, pergunta }: { tipo: "melhor" | "atencao"; c: CloserResumo; playbook: string; barra: number; etapaNome: (id: string) => string; pergunta?: string }) {
  const melhor = tipo === "melhor";
  const forte = c.etapas[0];
  const fraca = c.etapas.at(-1);
  return (
    <section className={cn("panel relative overflow-hidden p-5", melhor ? "ring-1 ring-ok/30" : "ring-1 ring-crit/30")}>
      <div className="flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
        {melhor ? <Medal className="size-3.5 text-ok" /> : <HeartHandshake className="size-3.5 text-crit" />}
        {melhor ? "Melhor closer agora" : "Precisa de mais atenção"}
        <Dica className="ml-auto">
          {melhor ? "Maior" : "Menor"} nota média entre os closers com pelo menos {MIN_CALLS_DESTAQUE} calls analisadas neste playbook. A nota mede aderência ao playbook, não venda: use para coaching, não para cobrança, até termos mais desfechos registrados.
        </Dica>
      </div>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <Link href={`/closers/${c.id}?playbook=${playbook}`} className="display text-3xl hover:text-primary md:text-4xl">{c.nome}</Link>
        <div className="text-right">
          <Score value={c.nota_media} barra={barra} size="xl" />
          <div className="mt-1 font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">nota média</div>
        </div>
      </div>
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">
        {c.analisadas} calls analisadas · <span className={cn((c.abaixo_pct ?? 0) > 0.3 ? "text-crit" : "text-foreground")}>{pct(c.abaixo_pct)} abaixo da barra</span> · fala {pct(c.fala_media)} do tempo
        {c.com_desfecho > 0 && <> · {c.ganhas} venda{c.ganhas === 1 ? "" : "s"} em {c.com_desfecho} com desfecho</>}
      </p>
      <div className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        {forte && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-ok">Mais forte em</div>
            <div className="mt-0.5 font-medium">{etapaNome(forte.id)}</div>
            <div className="text-xs text-muted-foreground">completa em {pct(forte.completo_pct)} das calls</div>
          </div>
        )}
        {fraca && fraca.id !== forte?.id && (
          <div className="rounded-lg border bg-muted/30 px-3 py-2">
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-crit">Mais fraco em</div>
            <div className="mt-0.5 font-medium">{etapaNome(fraca.id)}</div>
            <div className="text-xs text-muted-foreground">completa em {pct(fraca.completo_pct)} das calls</div>
          </div>
        )}
      </div>
      {!melhor && pergunta && (
        <div className="mt-3 rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-[12.5px] italic leading-snug">
          <span className="mr-1 not-italic font-mono text-[10px] uppercase tracking-[0.14em] text-primary">Treinar</span>
          {pergunta.replace(/^"|"$/g, "")}
        </div>
      )}
    </section>
  );
}

function seteDiasAtras() {
  return new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
}

type EtapaLegenda = { id: string; nome: string; em_uma_frase?: string; por_que_importa?: string; completo_quando: string; perguntas_exemplo: string[]; peso: number };

/**
 * Legenda das etapas do playbook (texto do próprio YAML): o que é, quando conta como completa, por que
 * importa e a pergunta para o closer treinar, com o % de falha do time ao lado.
 */
function LegendaEtapas({ etapas, falha, playbook, soLead }: { etapas: EtapaLegenda[]; falha: Record<string, number>; playbook: string; soLead: boolean }) {
  return (
    <section className="panel p-5">
      <SectionTitle icon={BookOpen} title="Como ler as etapas" aside={soLead ? `${playbook} · conta o que o lead disse, não o que o closer afirmou` : playbook} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[repeat(auto-fit,minmax(230px,1fr))]">
        {etapas.map((e, i) => {
          const f = falha[e.id];
          return (
            <div key={e.id} className="flex flex-col rounded-xl border bg-muted/30 p-4">
              <div className="flex items-start justify-between gap-2">
                <div className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
                  {i + 1} · {e.nome}
                  {e.peso > 1 && <span className="ml-1 text-primary">· vale {e.peso}×</span>}
                </div>
                {f !== undefined && (
                  <span
                    className={cn("shrink-0 rounded-full px-2 py-0.5 font-mono text-[10.5px]", f >= 0.75 ? "bg-crit/12 text-crit" : f >= 0.4 ? "bg-warn/15 text-warn" : "bg-ok/12 text-ok")}
                    title="% das calls analisadas em que a etapa não ficou completa"
                  >
                    falha {pct(f)}
                  </span>
                )}
              </div>
              {e.em_uma_frase && <p className="mt-2 text-[15px] font-semibold leading-snug">{e.em_uma_frase}</p>}
              <p className="mt-2 line-clamp-5 text-[12.5px] leading-relaxed text-muted-foreground" title={e.completo_quando.trim()}>
                <span className="font-medium text-foreground">Completa quando: </span>
                {e.completo_quando.trim()}
              </p>
              {e.por_que_importa && <p className="mt-2 text-[12.5px] leading-relaxed text-muted-foreground"><span className="font-medium text-foreground">Por que importa: </span>{e.por_que_importa}</p>}
              {e.perguntas_exemplo[0] && (
                <div className="mt-auto pt-3">
                  <div className="rounded-lg border border-primary/30 bg-primary/8 px-3 py-2 text-[12.5px] italic leading-snug">
                    <span className="mr-1 not-italic font-mono text-[10px] uppercase tracking-[0.14em] text-primary">Pergunte</span>
                    {e.perguntas_exemplo[0].replace(/^"|"$/g, "")}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
