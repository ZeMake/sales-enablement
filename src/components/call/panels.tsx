"use client";

import { BadgeCheck, FileText, FlaskConical, Lightbulb, ListChecks, ListTodo, MessageCircleQuestion, MessageSquareWarning, Network, Quote as QuoteIcon, ShieldAlert, TrendingUp } from "lucide-react";
import { useEffect, useId, useState, useTransition } from "react";
import { SectionTitle } from "@/components/ci/section";
import { setDesfecho, setNextStepStatus } from "@/app/actions";
import type { VerifiedAnalysis } from "@/core/analysis/schema";
import type { ReliabilityRow } from "@/core/queries";
import type { Segment } from "@/core/types";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DESFECHO_LABEL, OBJECAO_LABEL, humanize } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Quote } from "./workspace";

type Etapa = VerifiedAnalysis["etapas"][number];

// ---- Segunda opinião (Jev) ----
// O Jev não explica: só vota sim/não (ou escolhe um status) com um grau de certeza. Quem explica é
// a análise. Por isso: veredito no topo, porquê no meio, segunda opinião em frase completa no rodapé.

const certeza = (p: number) => {
  const pct = Math.round(p * 100);
  return pct >= 80 ? `certeza alta (${pct}%)` : pct >= 60 ? `certeza média (${pct}%)` : `pouca certeza (${pct}%)`;
};

/** A frase que o Jev "diria", sem depender de saber qual foi a pergunta. */
function fraseJev(r: ReliabilityRow, opusResolvida?: boolean): string {
  const concorda = r.nivel !== "divergente";
  switch (r.kind) {
    case "etapa":
      return concorda ? `Também avaliou esta etapa como ${r.jev}.` : `Avaliou esta etapa como ${r.jev}, não ${r.opus}.`;
    case "churn":
      return concorda ? "Também vê risco nesta fala." : "Não vê risco nesta fala.";
    case "objecao_existe":
      return concorda ? "Também vê uma objeção nesta fala." : "Não vê objeção nesta fala.";
    case "objecao_resolvida":
      if (concorda) return opusResolvida ? "Também acha que a objeção foi resolvida." : "Também acha que a objeção ficou em aberto.";
      return r.jev === "sim" ? "Acha que a objeção foi resolvida." : "Acha que a objeção ficou em aberto.";
    default:
      return r.jev;
  }
}

/** Rodapé "Segunda opinião": uma linha por pergunta, ✓ concorda / ⚠ discorda, e o que acontece quando discorda. */
export function SecondOpinion({ itens, consequencia }: { itens: Array<{ r?: ReliabilityRow; opusResolvida?: boolean }>; consequencia?: string }) {
  const linhas = itens.filter((x): x is { r: ReliabilityRow; opusResolvida?: boolean } => !!x.r);
  if (!linhas.length) return null;
  const algumaDiverge = linhas.some((x) => x.r.nivel === "divergente");
  return (
    <div
      className={cn("mt-3 rounded-md border px-3 py-2 text-[13px]", algumaDiverge ? "border-warn/40 bg-warn/5" : "border-border bg-muted/40")}
      title="Segunda opinião de outro modelo (Jev), independente da análise: ele só vota, com um grau de certeza, e não explica. Concordância entre dois modelos não é garantia de acerto."
    >
      <div className="mb-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Segunda opinião · Jev</div>
      <ul className="space-y-1">
        {linhas.map(({ r, opusResolvida }, i) => {
          const ok = r.nivel !== "divergente";
          return (
            <li key={i} className="flex gap-2 leading-snug">
              <span className={cn("shrink-0 font-semibold", ok ? "text-ok" : "text-warn")} aria-label={ok ? "concorda" : "discorda"}>
                {ok ? "✓" : "⚠"}
              </span>
              <span>
                {fraseJev(r, opusResolvida)} <span className="text-muted-foreground">· {certeza(r.prob)}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {algumaDiverge && consequencia && <p className="mt-1.5 text-[12px] text-muted-foreground">{consequencia}</p>}
    </div>
  );
}

/** Veredito do card. "revisao" = a segunda opinião contestou: não afirmamos, pedimos revisão. */
function Verdict({ tom, children }: { tom: "ok" | "crit" | "warn" | "revisao" | "neutro"; children: React.ReactNode }) {
  const cls = {
    ok: "bg-ok/15 text-ok ring-ok/35",
    crit: "bg-crit/15 text-crit ring-crit/35",
    warn: "bg-warn/15 text-warn ring-warn/35",
    revisao: "bg-transparent text-warn",
    neutro: "bg-muted text-muted-foreground ring-border",
  }[tom];
  return <span className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 font-mono text-[11px] font-medium uppercase tracking-wide ring-1 ring-inset", cls, tom === "revisao" && "border border-dashed border-warn/60 ring-0")}>{tom === "revisao" && "? "}{children}</span>;
}

const Porque = ({ titulo, children }: { titulo: string; children: React.ReactNode }) => (
  <div className="mt-2">
    <div className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{titulo}</div>
    <p className="mt-0.5 text-[13px] leading-relaxed">{children}</p>
  </div>
);

const relOf = (rel: ReliabilityRow[] | undefined, kind: string, ref: string | number) => rel?.find((x) => x.kind === kind && x.ref === String(ref));
const STATUS_STYLE: Record<string, string> = {
  completo: "bg-ok/15 text-ok ring-ok/35",
  parcial: "bg-warn/15 text-warn ring-warn/35",
  ausente: "bg-muted text-muted-foreground ring-border",
};

export function StagesPanel({
  etapas,
  names,
  rebaixadas,
  segments,
  rel,
}: {
  etapas: Etapa[];
  names: Record<string, string>;
  rebaixadas: Array<{ id: string; de: string; para: string; motivo: string }>;
  segments: Segment[];
  rel?: ReliabilityRow[];
}) {
  // Abre na etapa mais fraca: é onde está o coaching.
  const weakest = [...etapas].sort((a, b) => a.nota_0a10 - b.nota_0a10)[0]?.id;
  const [open, setOpen] = useState<string | undefined>(weakest);
  const e = etapas.find((x) => x.id === open);
  const reb = rebaixadas.find((r) => r.id === open);
  return (
    <section className="panel p-5">
      <SectionTitle icon={ListChecks} title="Etapas do playbook" />
      <div className="flex flex-wrap gap-1.5">
        {etapas.map((x) => (
          <button
            key={x.id}
            onClick={() => setOpen(x.id)}
            className={cn(
              "flex items-center gap-2 rounded-md px-2.5 py-1.5 text-xs font-medium ring-1 ring-inset transition",
              STATUS_STYLE[x.status],
              open === x.id && "ring-2 ring-foreground/60",
            )}
          >
            {names[x.id] ?? x.id}
            {relOf(rel, "etapa", x.id)?.nivel === "divergente" && <span className="font-mono text-warn" title="Em revisão: a segunda opinião discorda deste status">?</span>}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-muted-foreground">
        <span><span className="mr-1 inline-block size-2 rounded-sm bg-ok" />completo</span>
        <span><span className="mr-1 inline-block size-2 rounded-sm bg-warn" />parcial</span>
        <span><span className="mr-1 inline-block size-2 rounded-sm bg-muted-foreground/40" />ausente</span>
        {rel?.some((r) => r.kind === "etapa" && r.nivel === "divergente") && <span className="text-warn">? em revisão: a segunda opinião discorda</span>}
      </div>
      {e && (
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-xs">
              <span className={cn("rounded px-1.5 py-0.5 font-mono uppercase ring-1 ring-inset", STATUS_STYLE[e.status])}>{e.status}</span>
              {reb && <span className="font-mono text-[10.5px] text-muted-foreground">rebaixada de {reb.de}: {reb.motivo}</span>}
            </div>
            <SecondOpinion itens={[{ r: relOf(rel, "etapa", e.id) }]} consequencia="Enquanto ninguém decidir, a nota usa o status da análise e fica provisória (com faixa). Decida na calibração." />
            <div className="font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Evidências</div>
            {e.evidencias.length ? (
              e.evidencias.map((ev, i) => <Quote key={i} text={ev.citacao} idx={ev.segment_idx} speaker={segments[ev.segment_idx]?.speaker} />)
            ) : (
              <p className="text-sm text-muted-foreground">Nenhuma evidência válida na transcrição.</p>
            )}
          </div>
          <div className="space-y-3">
            <div>
              <div className="mb-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">O que faltou</div>
              <p className="text-sm leading-relaxed">{e.o_que_faltou || "—"}</p>
            </div>
            <div className="rounded-lg border border-primary/40 bg-primary/10 p-3.5">
              <div className="mb-1 flex items-center gap-1.5 font-mono text-[10.5px] uppercase tracking-[0.18em] text-primary"><MessageCircleQuestion className="size-3.5" /> Pergunta sugerida</div>
              <p className="text-sm font-medium leading-relaxed">“{e.pergunta_sugerida}”</p>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

export function CoachingPanel({ coaching }: { coaching: VerifiedAnalysis["coaching"] }) {
  const [first, ...rest] = coaching.melhorias;
  return (
    <section className="panel overflow-hidden">
      {first && (
        <div className="panel-hero rounded-none border-0 border-b p-5 shadow-none after:hidden">
          <SectionTitle icon={Lightbulb} title="O insight da call" className="mb-3" />
          <p className="relative text-[16px] font-semibold leading-snug">{first.ponto}</p>
          <div className="relative mt-4 flex gap-3 rounded-lg border border-primary/30 bg-background/60 p-3.5 text-sm leading-relaxed backdrop-blur">
            <QuoteIcon className="size-5 shrink-0 rotate-180 text-primary" fill="currentColor" strokeWidth={0} />
            <p>
              <span className="mr-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-primary">Diga assim</span>“{first.exemplo_de_frase}”
            </p>
          </div>
        </div>
      )}
      <div className="grid gap-5 p-5 md:grid-cols-2">
        <div>
          <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.14em]"><TrendingUp className="size-4 text-primary" /> Depois disso</div>
          <ol className="space-y-3">
            {rest.map((m, i) => (
              <li key={i} className="text-sm">
                <span className="mr-1.5 font-mono text-primary">{i + 2}.</span>
                {m.ponto}
                <p className="mt-1.5 border-l-2 border-primary/40 pl-3 text-[13px] italic text-muted-foreground">“{m.exemplo_de_frase}”</p>
              </li>
            ))}
            {!rest.length && <li className="text-sm text-muted-foreground">—</li>}
          </ol>
        </div>
        <div>
          <div className="mb-3 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-[0.14em]"><BadgeCheck className="size-4 text-ok" /> Pontos fortes</div>
          <ul className="space-y-2">
            {coaching.pontos_fortes.map((p, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="text-ok">✓</span>
                {p}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export function ChurnPanel({ riscos, segments, rel }: { riscos: VerifiedAnalysis["risco_churn"]; segments: Segment[]; rel?: ReliabilityRow[] }) {
  // Índice original: é por ele que a segunda opinião se liga ao risco.
  const itens = riscos.map((r, i) => ({ ...r, i, jev: relOf(rel, "churn", i) })).map((r) => ({ ...r, revisao: r.jev?.nivel === "divergente" }));
  // Confirmados primeiro (vermelho antes de amarelo); os contestados no fim, esmaecidos.
  const ordem = (r: (typeof itens)[number]) => (r.revisao ? 2 : 0) + (r.severidade === "vermelho" ? 0 : 1);
  const sorted = [...itens].sort((a, b) => ordem(a) - ordem(b));
  const emRevisao = itens.filter((r) => r.revisao).length;
  const comJev = itens.some((r) => r.jev);
  return (
    <section className="panel p-5">
      <SectionTitle
        icon={ShieldAlert}
        title={`Risco de churn na origem · ${riscos.length}`}
        aside={comJev && riscos.length > 0 ? `${riscos.length - emRevisao} confirmado(s)${emRevisao ? ` · ${emRevisao} em revisão` : ""}` : undefined}
      />
      {!riscos.length && <p className="text-sm text-muted-foreground">Nenhuma promessa de risco encontrada.</p>}
      <div className="space-y-4">
        {sorted.map((r) => (
          <div key={r.i} className={cn("rounded-md border-l-4 pl-3", r.revisao ? "border-warn/50 opacity-80" : r.severidade === "vermelho" ? "border-crit" : "border-warn")}>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
              <Verdict tom={r.revisao ? "revisao" : r.severidade === "vermelho" ? "crit" : "warn"}>{r.revisao ? `${r.severidade} · em revisão` : r.severidade}</Verdict>
              <span className="font-medium">{humanize(r.tipo)}</span>
            </div>
            <Quote text={r.citacao} idx={r.segment_idx} speaker={segments[r.segment_idx]?.speaker} />
            <Porque titulo={r.revisao ? "A análise diz que é risco porque" : "Por que é risco"}>{r.por_que_e_risco}</Porque>
            <Porque titulo="Como deveria ter dito">“{r.como_deveria_ter_dito}”</Porque>
            <SecondOpinion
              itens={[{ r: r.jev }]}
              consequencia={r.severidade === "vermelho" ? "Contestado: este risco não deixa a call crítica até alguém revisar." : "Contestado: fica para revisão."}
            />
          </div>
        ))}
      </div>
    </section>
  );
}

export function ObjectionsPanel({ objecoes, segments, rel }: { objecoes: VerifiedAnalysis["objecoes"]; segments: Segment[]; rel?: ReliabilityRow[] }) {
  const itens = objecoes.map((o, i) => {
    const existe = relOf(rel, "objecao_existe", i);
    const resolvida = relOf(rel, "objecao_resolvida", i);
    // Veredito único: se a segunda opinião contesta, não afirmamos — pedimos revisão.
    const estado =
      existe?.nivel === "divergente" ? { tom: "revisao" as const, txt: "em revisão: é objeção?" }
      : resolvida?.nivel === "divergente" ? { tom: "revisao" as const, txt: "em revisão: foi resolvida?" }
      : o.resolvida ? { tom: "ok" as const, txt: "resolvida" }
      : { tom: "crit" as const, txt: "em aberto" };
    return { o, i, existe, resolvida, estado };
  });
  const abertas = itens.filter((x) => x.estado.tom === "crit").length;
  const revisao = itens.filter((x) => x.estado.tom === "revisao").length;
  const sorted = [...itens].sort((a, b) => Number(a.estado.tom === "revisao") - Number(b.estado.tom === "revisao"));
  return (
    <section className="panel p-5">
      <SectionTitle
        icon={MessageSquareWarning}
        title={`Objeções · ${objecoes.length}`}
        aside={objecoes.length > 0 ? `${abertas} em aberto · ${itens.length - abertas - revisao} resolvida(s)${revisao ? ` · ${revisao} em revisão` : ""}` : undefined}
      />
      {!objecoes.length && <p className="text-sm text-muted-foreground">Nenhuma objeção levantada.</p>}
      <div className="space-y-4">
        {sorted.map(({ o, i, existe, resolvida, estado }) => (
          <div key={i} className={cn("rounded-md border-l-4 pl-3", estado.tom === "revisao" ? "border-warn/50 opacity-80" : estado.tom === "ok" ? "border-ok/60" : "border-crit")}>
            <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs">
              <span className="rounded bg-lead/15 px-1.5 py-0.5 font-mono uppercase text-lead">{OBJECAO_LABEL[o.tipo] ?? o.tipo}</span>
              <Verdict tom={estado.tom}>{estado.txt}</Verdict>
            </div>
            <Quote text={o.citacao} idx={o.segment_idx} speaker={segments[o.segment_idx]?.speaker} />
            {/* Em revisão, o porquê é a leitura da análise, não um fato: o título diz isso. */}
            <Porque
              titulo={
                estado.tom === "revisao"
                  ? o.resolvida ? "A análise diz que foi resolvida porque" : "A análise diz que ficou em aberto porque"
                  : o.resolvida ? "Como o closer resolveu" : "Por que ficou em aberto"
              }
            >
              {o.tratamento}
            </Porque>
            <SecondOpinion
              itens={[{ r: existe }, { r: resolvida, opusResolvida: o.resolvida }]}
              consequencia="Quando as duas leituras discordam, a objeção fica em revisão: decida ouvindo o trecho."
            />
          </div>
        ))}
      </div>
    </section>
  );
}

function SignalRow({ label, ok, children }: { label: string; ok: boolean; children?: React.ReactNode }) {
  return (
    <div className="border-t py-3 first:border-t-0 first:pt-0">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{label}</span>
        <span className={cn("font-mono text-[11px]", ok ? "text-ok" : "text-muted-foreground")}>{ok ? "sim" : "não"}</span>
      </div>
      {children && <div className="mt-2 space-y-2">{children}</div>}
    </div>
  );
}

export function SignalsPanel({ a, segments }: { a: VerifiedAnalysis; segments: Segment[] }) {
  const { reframe, custo_da_inacao: custo, cases, perguntas_closer: pq, sentimento_cliente: sent } = a;
  return (
    <section className="panel p-5">
      <SectionTitle icon={FlaskConical} title="Hipóteses de conversão" />
      <SignalRow label={`Reframe da dor${reframe.ocorreu ? ` · qualidade ${reframe.qualidade_0a3}/3` : ""}`} ok={reframe.ocorreu}>
        {reframe.ocorreu && (
          <>
            <p className="text-[13px] text-muted-foreground">
              <b className="text-foreground">De:</b> {reframe.dor_original} <b className="text-foreground">→ Para:</b> {reframe.dor_reposicionada}
            </p>
            {reframe.citacao && reframe.segment_idx != null && <Quote text={reframe.citacao} idx={reframe.segment_idx} speaker={segments[reframe.segment_idx]?.speaker} />}
          </>
        )}
      </SignalRow>
      <SignalRow label={`Custo da inação quantificado${custo.quem_quantificou ? ` · por ${custo.quem_quantificou}` : ""}`} ok={custo.quantificado}>
        {custo.quantificado && (
          <>
            {custo.valor && <p className="font-heading text-2xl text-primary">{custo.valor}</p>}
            {custo.citacao && custo.segment_idx != null && <Quote text={custo.citacao} idx={custo.segment_idx} speaker={segments[custo.segment_idx]?.speaker} />}
          </>
        )}
      </SignalRow>
      <SignalRow label={`Case mostrado${cases.momento ? ` · ${cases.momento === "a_pedido" ? "a pedido do lead" : "proativo"}` : ""}`} ok={cases.closer_mostrou} />
      <div className="border-t pt-3 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">Perguntas abertas / fechadas</span>
          <span className="font-mono">{pq.abertas} / {pq.fechadas}</span>
        </div>
        <div className="mt-1 flex justify-between">
          <span className="text-muted-foreground">Sentimento do lead</span>
          <span className="font-medium">{sent.geral}</span>
        </div>
        {sent.sinais_de_compra.length > 0 && (
          <ul className="mt-2 list-disc space-y-1 pl-5 text-[13px] text-muted-foreground">
            {sent.sinais_de_compra.map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        )}
      </div>
    </section>
  );
}

function BulletList({ items }: { items: string[] }) {
  return items.length ? <ul className="list-disc space-y-1 pl-5">{items.map((x, i) => <li key={i}>{x}</li>)}</ul> : <p className="text-muted-foreground">—</p>;
}

export function SummaryPanel({ resumo }: { resumo: VerifiedAnalysis["resumo"] }) {
  const d = resumo.decisao;
  return (
    <section className="panel p-5">
      <SectionTitle icon={FileText} title="Resumo" />
      <div className="grid gap-4 text-[13px] leading-relaxed md:grid-cols-2">
        <div className="md:col-span-2">
          <div className="mb-1 font-semibold">Contexto</div>
          <p>{resumo.contexto}</p>
        </div>
        <div>
          <div className="mb-1 font-semibold">Dores</div>
          <BulletList items={resumo.dores} />
        </div>
        <div>
          <div className="mb-1 font-semibold">Impacto financeiro</div>
          <p>{resumo.impacto_financeiro.descricao || "—"}</p>
          {resumo.impacto_financeiro.valores.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {resumo.impacto_financeiro.valores.map((v, i) => (
                <span key={i} className="rounded bg-primary/15 px-2 py-0.5 font-mono text-xs text-primary">{v}</span>
              ))}
            </div>
          )}
        </div>
        <div>
          <div className="mb-1 font-semibold">Evento crítico</div>
          <p>{resumo.evento_critico || "—"}</p>
        </div>
        <div>
          <div className="mb-1 font-semibold">Decisão</div>
          <p><span className="text-muted-foreground">Decisores:</span> {d.decisores.join(", ") || "—"}</p>
          <p><span className="text-muted-foreground">Critérios:</span> {d.criterios.join("; ") || "—"}</p>
          <p><span className="text-muted-foreground">Processo:</span> {d.processo || "—"}</p>
          <p><span className="text-muted-foreground">Alternativas:</span> {d.alternativas_avaliadas.join(", ") || "—"}</p>
        </div>
      </div>
    </section>
  );
}

export function NextStepsPanel({ steps }: { steps: Array<{ id: number; responsavel: string | null; tarefa: string; prazo: string | null; status: string; citacao: string | null }> }) {
  const [pending, start] = useTransition();
  return (
    <section className={cn("panel p-5", pending && "opacity-70")}>
      <SectionTitle icon={ListTodo} title="Próximos passos" />
      {!steps.length && <p className="text-sm text-muted-foreground">Nenhum próximo passo combinado.</p>}
      <ul className="space-y-2.5">
        {steps.map((s) => (
          <li key={s.id} className="flex items-start gap-3">
            <Checkbox
              checked={s.status === "feito"}
              onCheckedChange={(v) => start(() => setNextStepStatus(s.id, v === true))}
              className="so-escrita mt-0.5"
              aria-label={`Marcar "${s.tarefa}" como feito`}
            />
            <div className={cn("text-sm", s.status === "feito" && "text-muted-foreground line-through")}>
              <span className="font-medium">{s.responsavel}:</span> {s.tarefa}
              {s.prazo && <span className="ml-2 rounded bg-secondary px-1.5 py-0.5 font-mono text-[11px]">{s.prazo}</span>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function DesfechoSelect({ callId, value }: { callId: string; value: string | null }) {
  const [pending, start] = useTransition();
  return (
    <Select value={value ?? "__sem__"} onValueChange={(v) => start(() => setDesfecho(callId, v === "__sem__" ? "" : v))} disabled={pending}>
      <SelectTrigger size="sm" className="so-escrita w-[160px]">
        {/* Texto explícito: sem ele o Radix só preenche depois de hidratar e o campo aparece vazio. */}
        <SelectValue>{value ? (DESFECHO_LABEL[value] ?? value) : "Sem desfecho"}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="__sem__">Sem desfecho</SelectItem>
        {Object.entries(DESFECHO_LABEL).map(([v, l]) => (
          <SelectItem key={v} value={v}>{l}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Mapa mental em Mermaid, renderizado no cliente com o tema atual. */
export function MindMap({ code }: { code: string }) {
  const id = useId().replace(/:/g, "");
  const [svg, setSvg] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const { default: mermaid } = await import("mermaid");
        const dark = document.documentElement.classList.contains("dark");
        mermaid.initialize({ startOnLoad: false, theme: dark ? "dark" : "neutral", securityLevel: "strict", fontFamily: "var(--font-body)" });
        const { svg } = await mermaid.render(`mm-${id}`, code);
        if (alive) setSvg(svg);
      } catch (e) {
        if (alive) setError((e as Error).message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [code, id]);
  return (
    <section className="panel p-5">
      <SectionTitle icon={Network} title="Mapa mental" />
      {svg ? (
        <div className="overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg }} />
      ) : error ? (
        <div>
          <p className="mb-2 text-xs text-muted-foreground">Não foi possível desenhar o mapa ({error.slice(0, 80)}). Código gerado:</p>
          <pre className="overflow-x-auto rounded bg-muted p-3 font-mono text-xs">{code}</pre>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">desenhando…</p>
      )}
    </section>
  );
}
