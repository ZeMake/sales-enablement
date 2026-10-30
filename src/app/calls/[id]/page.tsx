import { ArrowLeft, BookOpen, CalendarDays, Clock3, ExternalLink, Flame, NotebookPen, Package, Target, Timer, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Score, StatusBadge } from "@/components/ci/badges";
import { SectionTitle, splitAccent } from "@/components/ci/section";
import {
  ChurnPanel,
  CoachingPanel,
  DesfechoSelect,
  MindMap,
  NextStepsPanel,
  ObjectionsPanel,
  SignalsPanel,
  StagesPanel,
  SummaryPanel,
} from "@/components/call/panels";
import { AnalisarPlaybook } from "@/components/call/analisar-playbook";
import { MediaTranscript, Quote, Timeline, Workspace, type Marker } from "@/components/call/workspace";
import { jobsDaCall } from "@/core/jobs";
import { mediaUrl } from "@/core/media";
import { isActive } from "@/core/playbook";
import { getCallDetail } from "@/core/queries";
import { dataCurta, mmss, pct } from "@/lib/format";
import { podeAdicionar } from "@/lib/acesso";
import { getContext } from "@/lib/server/context";
import { cn } from "@/lib/utils";

export async function generateMetadata(props: PageProps<"/calls/[id]">) {
  const { id } = await props.params;
  return { title: id };
}

export default async function CallPage(props: PageProps<"/calls/[id]">) {
  const { id } = await props.params;
  const sp = await props.searchParams;
  const { db, viewer, playbooks, barra } = await getContext();
  const requested = Array.isArray(sp.playbook) ? sp.playbook[0] : sp.playbook;
  const d = await getCallDetail(db, viewer, id, requested);
  if (!d) notFound();

  const a = d.analysis?.result;
  const pb = playbooks.find((p) => p.id === d.analysis?.playbook_id);
  const names = Object.fromEntries((pb?.etapas ?? []).map((e) => [e.id, e.nome]));
  const m = d.metrics;
  // Playbooks que a call (comercial, já analisada em algum) ainda não tem: botão para analisar pela fila.
  // Sem nenhuma análise, a call está na análise do PC: o botão a analisaria em dobro.
  const faltam = d.call.triage_status === "comercial" && d.analyses.length > 0 ? playbooks.filter((p) => isActive(p) && !d.analyses.some((x) => x.playbook_id === p.id)) : [];
  const job = faltam.length ? (await jobsDaCall(db, id)).find((j) => j.status !== "erro") : undefined;
  const botao = faltam.length > 0 && podeAdicionar() && (
    <AnalisarPlaybook callId={id} playbooks={faltam.map((p) => ({ id: p.id, nome: p.nome }))} andamento={job ? (job.etapa ?? "na fila") : undefined} />
  );

  const markers: Marker[] = a
    ? [
        ...a.etapas.flatMap((e) => e.evidencias.map((ev) => ({ idx: ev.segment_idx, kind: "etapa" as const, label: names[e.id] ?? e.id, tone: e.status === "completo" ? ("ok" as const) : ("warn" as const) }))),
        ...a.objecoes.map((o) => ({ idx: o.segment_idx, kind: "objecao" as const, label: `objeção: ${o.tipo}`, tone: "lead" as const })),
        ...a.risco_churn.map((r) => ({ idx: r.segment_idx, kind: "churn" as const, label: `churn ${r.severidade}`, tone: r.severidade === "vermelho" ? ("crit" as const) : ("warn" as const) })),
        ...(a.reframe.ocorreu && a.reframe.segment_idx != null ? [{ idx: a.reframe.segment_idx, kind: "reframe" as const, label: "reframe", tone: "primary" as const }] : []),
        ...(a.custo_da_inacao.quantificado && a.custo_da_inacao.segment_idx != null ? [{ idx: a.custo_da_inacao.segment_idx, kind: "custo" as const, label: "custo da inação", tone: "primary" as const }] : []),
      ]
    : [];
  const redFlags = a?.risco_churn.filter((r) => r.severidade === "vermelho") ?? [];
  const lead = splitAccent(d.lead);

  return (
    <Workspace segments={d.segments}>
      <div className="space-y-5">
        {/* Cabeçalho: lead (sobrenome em laranja), metadados com ícones, nota num card próprio. */}
        <div className="flex flex-wrap items-start gap-6">
          <div className="min-w-0 flex-1">
            <Link href={`/calls${requested ? `?playbook=${requested}` : ""}`} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground">
              <ArrowLeft className="size-4" /> Calls
            </Link>
            <h1 className="display mt-3 truncate text-[2.6rem] md:text-[3.4rem]">
              {lead.title} <span className="text-brand">{lead.accent}</span>
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-muted-foreground">
              <Meta icon={UserRound}>
                closer <Link href={`/closers/${d.call.closer_id}`} className="font-medium text-foreground hover:text-primary">{d.closer_nome}</Link>
              </Meta>
              <Meta icon={CalendarDays}>{dataCurta(d.call.data_hora ?? d.call.ingested_at)}</Meta>
              <Meta icon={Clock3}><span className="font-mono">{mmss(d.call.duration_sec)}</span></Meta>
              {d.call.produto && <Meta icon={Package}>{d.call.produto}</Meta>}
              {m && (
                <Meta icon={Flame} tone={m.fala_pct.closer > 0.65 ? "crit" : undefined}>
                  closer falou {pct(m.fala_pct.closer)}
                  {m.tempo_estimado ? "*" : ""}
                </Meta>
              )}
              {m && <Meta icon={Timer}>maior monólogo {mmss(m.maior_monologo_closer_seg)}</Meta>}
              {d.call.crm_url && (
                <a href={d.call.crm_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                  abrir no CRM <ExternalLink className="size-3.5" />
                </a>
              )}
            </div>
          </div>
          <div className="panel p-4 pr-5">
            <div className="flex items-start gap-5">
              <div>
                <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Nota</div>
                <div className="mt-1.5"><Score value={d.analysis?.nota_aderencia} barra={barra} size="xl" /></div>
                {d.analysis && <NotaValidacao a={d.analysis} barra={barra} names={names} />}
              </div>
              <div className="ml-auto space-y-3 border-l pl-5">
                <StatusBadge status={d.analysis?.classificacao} className="text-xs" />
                <div>
                  <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Desfecho</div>
                  <DesfechoSelect callId={d.call.id} value={d.call.desfecho} />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Seletor de playbook */}
        {(d.analyses.length > 0 || botao) && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="pill pointer-events-none border-transparent px-2 font-mono text-[10.5px] uppercase tracking-[0.18em]">
              <BookOpen className="size-3.5 text-primary" /> Playbook
            </span>
            {d.analyses.map((x) => (
              <Link key={x.id} href={`/calls/${id}?playbook=${x.playbook_id}`} className={cn("pill", x.id === d.analysis?.id && "pill-active")}>
                {playbooks.find((p) => p.id === x.playbook_id)?.nome ?? x.playbook_id}
                <span className="font-mono text-xs opacity-80">{Math.round(x.nota_aderencia ?? 0)}</span>
              </Link>
            ))}
            {botao}
            {d.analysis && (
              <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">
                {d.analysis.prompt_version} · {d.analysis.model} · {d.analysis.citacoes_descartadas}/{d.analysis.citacoes_total} citações descartadas · US$ {d.analysis.custo_usd?.toFixed(2)}
                {d.analysis.billing === "assinatura" ? " (equiv., assinatura)" : ""}
              </span>
            )}
          </div>
        )}

        {pb && d.stages.length > 0 && <NotaComposicao etapas={pb.etapas} stages={d.stages} rel={d.reliability} nota={d.analysis?.nota_aderencia ?? null} />}

        {!a ? (
          <div className="panel p-10 text-center text-muted-foreground">
            {d.call.triage_status === "comercial" ? (
              <>Call ainda não analisada{botao ? ": use o botão acima." : <>. Rode <code className="font-mono">pnpm analyze --call {id}</code>.</>}</>
            ) : (
              <>Triagem: não comercial — {d.call.triage_motivo}. Não recebe nota.</>
            )}
          </div>
        ) : (
          <>
            {/* Por que é crítica / em atenção: motivos + as citações que pesaram. */}
            {d.analysis!.motivos && d.analysis!.motivos.length > 0 && (
              <section className="panel-hero p-5">
                <div className={cn("absolute inset-y-0 left-0 w-1", d.analysis!.classificacao === "critica" ? "bg-crit" : "bg-brand")} />
                <div className="relative grid gap-5 md:grid-cols-[1fr_1.15fr]">
                  <div>
                    <SectionTitle icon={Target} title={`Por que está ${d.analysis!.classificacao === "critica" ? "crítica" : "em atenção"}`} />
                    <ul className="space-y-2 text-sm">
                      {d.analysis!.motivos.map((mo, i) => (
                        <li key={i} className="flex gap-2.5 leading-snug">
                          <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", d.analysis!.classificacao === "critica" ? "bg-crit" : "bg-primary")} />
                          {mo}
                        </li>
                      ))}
                    </ul>
                  </div>
                  {redFlags.length > 0 && (
                    <div className="space-y-2">
                      <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Promessas de risco · clique para ouvir</div>
                      {redFlags.slice(0, 3).map((r, i) => (
                        <Quote key={i} text={r.citacao} idx={r.segment_idx} speaker={d.segments[r.segment_idx]?.speaker} />
                      ))}
                    </div>
                  )}
                </div>
              </section>
            )}

            <Timeline segments={d.segments} markers={markers} estimado={d.call.tempo_estimado} />

            <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(0,0.9fr)]">
              <div className="space-y-5">
                <CoachingPanel coaching={a.coaching} />
                {d.reliability.length > 0 && <ComoLer />}
                <StagesPanel etapas={a.etapas} names={names} rebaixadas={a.verificacao.etapas_rebaixadas} segments={d.segments} rel={d.reliability} />
                <ChurnPanel riscos={a.risco_churn} segments={d.segments} rel={d.reliability} />
                <ObjectionsPanel objecoes={a.objecoes} segments={d.segments} rel={d.reliability} />
                <SignalsPanel a={a} segments={d.segments} />
                <SummaryPanel resumo={a.resumo} />
                <NextStepsPanel steps={d.nextSteps} />
                <MindMap code={a.mapa_mental_mermaid} />
                {a.observacoes && (
                  <section className="panel p-5">
                    <SectionTitle icon={NotebookPen} title="Observações da análise" aside={`confiança ${a.confianca}`} />
                    <p className="text-[13px] leading-relaxed text-muted-foreground">{a.observacoes}</p>
                  </section>
                )}
              </div>
              <div className="xl:sticky xl:top-20 xl:h-[calc(100vh-6rem)]">
                <MediaTranscript
                  segments={d.segments}
                  mediaUrl={d.call.media_path ? await mediaUrl(d.call.id, d.call.media_path) : undefined}
                  markers={markers}
                  estimado={d.call.tempo_estimado}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Workspace>
  );
}

/**
 * Como a nota foi validada. A nota vem só do status das etapas (completo 10 · parcial 5 · ausente 0);
 * "validada" = o Jev concorda com todas as etapas (ou você decidiu as divergentes na calibração).
 */
function NotaValidacao({ a, barra, names }: { a: { validacao: string | null; nota_min: number | null; nota_max: number | null; etapas_em_revisao: string[] | null }; barra: number; names: Record<string, string> }) {
  const revisao = a.etapas_em_revisao ?? [];
  const faixa = a.nota_min != null && a.nota_max != null && Math.round(a.nota_min) !== Math.round(a.nota_max);
  const selo =
    a.validacao === "validada"
      ? { txt: "validada", cls: "text-ok", tip: "O segundo avaliador (Jev) concorda com o status de todas as etapas, ou as divergentes já foram decididas por você." }
      : a.validacao === "provisoria"
        ? { txt: "provisória", cls: "text-warn", tip: `Opus e Jev discordam em: ${revisao.map((r) => names[r] ?? r).join(", ")}. A nota usa o status do Opus até você decidir (pnpm calibrate).` }
        : { txt: "sem confirmação", cls: "text-muted-foreground", tip: "O Jev ainda não avaliou esta análise (pnpm reliability)." };
  return (
    <div className="mt-1 space-y-0.5 font-mono text-[10.5px] text-muted-foreground" title={selo.tip}>
      <div>
        <span className={selo.cls}>● nota {selo.txt}</span> · barra {barra}
      </div>
      {faixa && <div>faixa {Math.round(a.nota_min!)}–{Math.round(a.nota_max!)} · {revisao.length} etapa(s) em revisão</div>}
    </div>
  );
}

/** Legenda curta, uma vez por página: quem dá o veredito, quem confere e o que fazer quando discordam. */
function ComoLer() {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5 rounded-xl border border-dashed px-4 py-3 text-[12.5px] text-muted-foreground">
      <span className="font-mono text-[10px] uppercase tracking-wider text-foreground">Como ler</span>
      <span><b className="font-medium text-foreground">Veredito e porquê</b> vêm da análise.</span>
      <span><b className="font-medium text-foreground">Segunda opinião</b> é outro modelo conferindo: só vota, com um grau de certeza.</span>
      <span><span className="text-ok">✓</span> concordam · <span className="text-warn">⚠ ?</span> discordam = em revisão (você decide na calibração)</span>
    </div>
  );
}

function Meta({ icon: Icon, tone, children }: { icon: LucideIcon; tone?: "crit"; children: React.ReactNode }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5", tone === "crit" && "text-crit")}>
      <Icon className={cn("size-4", tone === "crit" ? "text-crit" : "text-primary")} strokeWidth={2} />
      {children}
    </span>
  );
}

const PONTOS: Record<string, number> = { completo: 10, parcial: 5, ausente: 0 };
const STATUS_COR: Record<string, string> = { completo: "bg-ok", parcial: "bg-warn", ausente: "bg-muted-foreground/30" };
const fmt = (n: number) => String(Math.round(n * 100) / 100).replace(".", ",");

/**
 * Como a nota foi composta, em faixa horizontal: cada etapa é uma fatia de 100 proporcional ao peso no
 * playbook e ganha a fatia inteira (completo), metade (parcial) ou zero (ausente). Etapa em revisão
 * mostra quanto a nota mudaria se a segunda opinião estiver certa.
 */
function NotaComposicao({
  etapas,
  stages,
  rel,
  nota,
}: {
  etapas: Array<{ id: string; nome: string; peso: number }>;
  stages: Array<{ stage_id: string; status: string }>;
  rel: Array<{ kind: string; ref: string; jev: string; nivel: string }>;
  nota: number | null;
}) {
  const total = etapas.reduce((a, e) => a + e.peso, 0);
  const linhas = etapas.map((e) => {
    const status = stages.find((s) => s.stage_id === e.id)?.status ?? "ausente";
    const max = (e.peso / total) * 100;
    const pts = (max * (PONTOS[status] ?? 0)) / 10;
    const j = rel.find((r) => r.kind === "etapa" && r.ref === e.id && r.nivel === "divergente");
    const delta = j ? (max * ((PONTOS[j.jev] ?? 0) - (PONTOS[status] ?? 0))) / 10 : 0;
    return { ...e, status, max, pts, jev: j?.jev, delta };
  });
  const soma = linhas.reduce((a, l) => a + l.pts, 0);
  return (
    <section className="panel p-5">
      <div className="grid gap-6 lg:grid-cols-[210px_1fr] lg:items-center">
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Como chegou nessa nota</div>
          <div className="mt-1.5 font-heading text-5xl leading-none tabular-nums">
            {fmt(Math.round(soma * 100) / 100)}
            <span className="ml-1 font-mono text-base text-muted-foreground">/100</span>
          </div>
          <div className="mt-2 text-[11.5px] leading-snug text-muted-foreground">completo = fatia inteira · parcial = metade · ausente = zero</div>
          {nota != null && Math.abs(nota - soma) > 0.05 && <div className="mt-1 text-[11.5px] text-crit">registrada: {fmt(nota)}</div>}
        </div>
        <div>
          {/* Barra única: cada fatia = peso da etapa; preenchimento = o que ela conquistou. */}
          <div className="flex h-3 gap-[3px]">
            {linhas.map((l) => (
              <div key={l.id} className="h-full overflow-hidden rounded-[4px] bg-muted" style={{ flexGrow: l.max }} title={`${l.nome}: +${fmt(l.pts)} de ${fmt(l.max)}`}>
                <div className={cn("h-full", STATUS_COR[l.status])} style={{ width: `${(l.pts / l.max) * 100}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-3 grid gap-3" style={{ gridTemplateColumns: linhas.map((l) => `minmax(0, ${l.max}fr)`).join(" ") }}>
            {linhas.map((l) => (
              <div key={l.id} className="min-w-0">
                <div className="truncate text-[13px] font-medium" title={l.nome}>{l.nome}</div>
                <div className="mt-0.5 flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                  <span className={cn("size-1.5 shrink-0 rounded-full", STATUS_COR[l.status])} />
                  {l.status}
                </div>
                <div className="mt-1 font-mono text-[13px] tabular-nums">
                  <b className={cn("font-semibold", l.pts === l.max ? "text-ok" : l.pts === 0 ? "text-crit" : "text-foreground")}>+{fmt(l.pts)}</b>
                  <span className="text-muted-foreground">/{fmt(l.max)}</span>
                </div>
                {l.jev && (
                  <div className="mt-1 text-[11px] leading-tight text-warn" title="A segunda opinião discorda deste status; decida na calibração.">
                    ? revisão: {l.jev} ({l.delta >= 0 ? "+" : "−"}
                    {fmt(Math.abs(l.delta))})
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
