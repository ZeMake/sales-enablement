import { Gauge, GraduationCap, LineChart, ListChecks, MessageCircleQuestion, Mic, Phone, TrendingDown, Trophy } from "lucide-react";
import { SectionTitle, splitAccent } from "@/components/ci/section";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Score, StageChips, Stat, StatusBadge, TalkBar } from "@/components/ci/badges";
import { ScoreTrend, StageCoverage } from "@/components/ci/charts";
import { UrlSelect } from "@/components/ci/url-select";
import { closerSummary } from "@/core/queries";
import { DESFECHO_LABEL, dataCurta, pct } from "@/lib/format";
import { getContext, resolvePlaybook } from "@/lib/server/context";

export default async function CloserPage(props: PageProps<"/closers/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const { db, viewer, barra, playbooks, stageName } = await getContext();
  const playbook = await resolvePlaybook(sp.playbook);
  const s = await closerSummary(db, viewer, id, playbook, barra);
  if (!s) notFound();
  const nomeSplit = splitAccent(s.closer.nome);
  const pb = playbooks.find((p) => p.id === playbook)!;
  const names = Object.fromEntries(pb.etapas.map((e) => [e.id, e.nome]));
  const trend = s.calls
    .filter((c) => c.analysis?.nota != null)
    .sort((a, b) => (a.data ?? "").localeCompare(b.data ?? "") || a.id.localeCompare(b.id))
    .map((c) => ({ label: c.data?.length === 10 ? dataCurta(c.data) : c.id.replace(/^reuniao-/, ""), nota: Math.round(c.analysis!.nota!) }));
  const order = pb.etapas.map((e) => e.id);
  const coverage = [...s.cobertura].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id)).map((c) => ({ etapa: names[c.id] ?? c.id, ...c }));
  const conv = s.conversao.com_desfecho ? s.conversao.ganhas / s.conversao.com_desfecho : null;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <Link href={`/closers?playbook=${playbook}`} className="text-sm text-muted-foreground hover:text-foreground">← Closers</Link>
          <h1 className="display mt-2 text-[2.6rem] md:text-5xl">{nomeSplit.title} <span className="text-brand">{nomeSplit.accent}</span></h1>
          <p className="mt-2 text-sm text-muted-foreground">{s.calls.length} calls · {s.analisadas} analisadas em {pb.nome}</p>
        </div>
        <Suspense>
          <UrlSelect param="playbook" placeholder="Playbook" fallback={playbook} options={playbooks.map((p) => ({ value: p.id, label: p.nome }))} className="w-[210px]" />
        </Suspense>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Stat icon={TrendingDown} label="Abaixo da barra" value={pct(s.abaixo_da_barra_pct)} tone={s.abaixo_da_barra_pct && s.abaixo_da_barra_pct > 0.3 ? "crit" : undefined} hint={`barra mínima ${barra}`} />
        <Stat icon={Gauge} label="Nota média" value={s.nota_media == null ? "—" : Math.round(s.nota_media)} />
        <Stat icon={Mic} label="Fala média" value={pct(s.fala_media)} tone={s.fala_media && s.fala_media > 0.65 ? "crit" : undefined} hint="meta do playbook: lead fala 70%" />
        <Stat icon={MessageCircleQuestion} label="Perguntas / call" value={s.perguntas_media == null ? "—" : Math.round(s.perguntas_media)} hint="contagem por interrogação" />
        <Stat icon={Trophy} label="Conversão" value={pct(conv)} hint={s.conversao.com_desfecho ? `${s.conversao.ganhas} de ${s.conversao.com_desfecho} com desfecho` : "sem desfecho preenchido"} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel p-5">
          <SectionTitle icon={LineChart} title="Evolução da nota" />
          {trend.length ? <ScoreTrend data={trend} barra={barra} /> : <p className="text-sm text-muted-foreground">Sem análises.</p>}
        </section>
        <section className="panel p-5">
          <SectionTitle icon={ListChecks} title="Cobertura por etapa" />
          {coverage.length ? <StageCoverage data={coverage} /> : <p className="text-sm text-muted-foreground">Sem análises.</p>}
        </section>
      </div>

      <section className="panel p-5">
        <SectionTitle icon={GraduationCap} title="Temas de coaching mais recorrentes" />
        <div className="grid gap-3 md:grid-cols-3">
          {s.temas_coaching.map((t, i) => (
            <div key={t.tema} className="rounded-md border p-3">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold">
                  <span className="mr-1.5 font-mono text-primary">{i + 1}.</span>
                  {stageName(playbook, t.tema)}
                </span>
                <span className="font-mono text-xs text-muted-foreground">{t.vezes}× a etapa mais fraca</span>
              </div>
              <p className="mt-2 text-[13px] leading-relaxed text-muted-foreground">{t.exemplo}</p>
            </div>
          ))}
          {!s.temas_coaching.length && <p className="text-sm text-muted-foreground">Sem análises.</p>}
        </div>
      </section>

      <section className="panel overflow-hidden">
        <SectionTitle icon={Phone} title="Calls" className="px-5 pt-5 mb-3" />
        <div className="divide-y">
          {s.calls.map((c) => (
            <Link key={c.id} href={`/calls/${c.id}?playbook=${playbook}`} className="flex flex-wrap items-center gap-4 px-4 py-3 hover:bg-secondary/60">
              <span className="w-14 font-mono text-xs text-muted-foreground">{dataCurta(c.data)}</span>
              <span className="min-w-[180px] flex-1 truncate font-medium">{c.lead}</span>
              <Score value={c.analysis?.nota} barra={barra} />
              {c.analysis && <StageChips etapas={c.analysis.etapas} names={names} />}
              <TalkBar closer={c.fala_closer} estimado={c.tempo_estimado} />
              <span className="w-24 text-sm text-muted-foreground">{c.desfecho ? DESFECHO_LABEL[c.desfecho] : "—"}</span>
              <StatusBadge status={c.analysis?.classificacao} />
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}
