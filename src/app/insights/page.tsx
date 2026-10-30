import { BarChart3, CircleDashed, FlaskConical, ListChecks, Scale, ScanSearch, Target, Trophy } from "lucide-react";
import { SectionTitle } from "@/components/ci/section";
import { Suspense } from "react";
import { Stat } from "@/components/ci/badges";
import { UrlSelect } from "@/components/ci/url-select";
import { buildInsights, N_MINIMO, type Grupo, type Predicao } from "@/core/insights";
import { pct } from "@/lib/format";
import { getContext, resolvePlaybook } from "@/lib/server/context";
import { cn } from "@/lib/utils";

export const metadata = { title: "Insights" };

export default async function InsightsPage(props: PageProps<"/insights">) {
  const sp = await props.searchParams;
  const { db, viewer, playbooks, stageName } = await getContext();
  const playbook = await resolvePlaybook(sp.playbook);
  const ins = await buildInsights(db, viewer, playbooks);
  const p = ins.playbooks.find((x) => x.playbook_id === playbook)!;
  const pb = playbooks.find((x) => x.id === playbook)!;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Validação · {pb.nome}</div>
          <h1 className="display mt-2 text-[2.6rem] md:text-5xl">
            A nota <span className="text-brand">prevê a venda?</span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Se quem segue o playbook converte igual a quem não segue, o problema é o playbook, não o closer. Só entram calls com desfecho ganho ou perdido.
          </p>
        </div>
        <Suspense>
          <UrlSelect param="playbook" placeholder="Playbook" fallback={playbook} options={playbooks.map((x) => ({ value: x.id, label: x.nome }))} className="w-[210px]" />
        </Suspense>
      </div>

      <div className="rounded-md border border-warn/40 bg-warn/10 px-4 py-3 text-sm">
        <b>Correlação não é causa.</b> Um grupo que converte mais pode ter outro motivo (lead mais quente, produto, época). Grupos com menos de {N_MINIMO} calls
        aparecem apagados: servem para acompanhar, não para decidir.
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Trophy} label="Calls com desfecho" value={ins.com_desfecho} hint="ganho ou perdido" tone={ins.com_desfecho < N_MINIMO ? "warn" : undefined} />
        <Stat icon={ScanSearch} label="Analisadas neste playbook" value={p.n} hint="com desfecho e nota" />
        <Stat icon={CircleDashed} label="Sem desfecho" value={ins.sem_desfecho} hint={ins.em_andamento ? `+ ${ins.em_andamento} em andamento` : "preencha para entrarem aqui"} />
        <Stat icon={Target} label="Poder de previsão (AUC)" value={p.predicao.auc == null ? "—" : p.predicao.auc.toFixed(2)} hint="0,5 = moeda · 1 = separa ganho de perdido" />
      </div>

      {!p.n ? (
        <section className="panel px-6 py-10 text-center">
          <div className="eyebrow justify-center">Sem dados ainda</div>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">
            Nenhuma call analisada neste playbook tem desfecho. Marque <b>ganho</b> ou <b>perdido</b> no cabeçalho de cada call (<code className="font-mono">/calls/[id]</code>) ou
            preencha a coluna <code className="font-mono">desfecho</code> do <code className="font-mono">data/inbox/manifest.csv</code> e rode <code className="font-mono">pnpm ingest</code> (não reprocessa nem reanalisa).
          </p>
        </section>
      ) : (
        <>
          <Veredito pred={p.predicao} />
          <div className="grid gap-5 lg:grid-cols-2">
            <section className="panel p-5">
              <SectionTitle icon={BarChart3} title="Conversão por faixa de nota" className="mb-2" />
              <p className="mb-3 text-xs text-muted-foreground">Calls ordenadas pela nota e divididas em até 5 faixas. Se o playbook funciona, a conversão sobe da primeira para a última.</p>
              <Bars grupos={p.quintis.map((q, i) => ({ ...q, label: `${i + 1}ª · nota ${q.label}` }))} />
            </section>
            <section className="panel p-5">
              <SectionTitle icon={FlaskConical} title="Hipóteses que movem conversão" className="mb-2" />
              <div className="mt-3 space-y-5">
                {p.hipoteses.map((h) => (
                  <div key={h.id}>
                    <div className="mb-1.5 text-sm font-medium">{h.titulo}</div>
                    <Bars grupos={h.grupos} />
                  </div>
                ))}
              </div>
            </section>
          </div>
          <section className="panel p-5">
            <SectionTitle icon={ListChecks} title="Conversão com cada etapa completa vs. não" className="mb-2" />
            <p className="mb-3 text-xs text-muted-foreground">Etapa que não muda a conversão é candidata a sair do playbook (ou o critério dela está errado).</p>
            <div className="grid gap-x-8 gap-y-4 md:grid-cols-2">
              {p.etapas.map((e) => (
                <div key={e.id}>
                  <div className="mb-1.5 flex items-baseline justify-between text-sm">
                    <span className="font-medium">{stageName(playbook, e.id)}</span>
                    <span className="font-mono text-xs text-muted-foreground">{e.diferenca == null ? "—" : `${e.diferenca >= 0 ? "+" : ""}${Math.round(e.diferenca * 100)} p.p.`}</span>
                  </div>
                  <Bars grupos={[e.completa, e.nao]} />
                </div>
              ))}
            </div>
          </section>
        </>
      )}

      {ins.comparacao && (
        <section className="panel p-5">
          <SectionTitle icon={Scale} title="SPICED × playbook da Make" className="mb-2" />
          <p className="mb-3 text-xs text-muted-foreground">Nas mesmas calls (com as duas análises e desfecho): qual nota separa melhor ganho de perdido.</p>
          <table className="w-full text-sm">
            <thead className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
              <tr className="text-left">
                <th className="pb-2">Playbook</th>
                <th className="pb-2 text-right">n</th>
                <th className="pb-2 text-right">AUC</th>
                <th className="pb-2 text-right">Correlação</th>
                <th className="pb-2 text-right">Nota média ganhas</th>
                <th className="pb-2 text-right">Nota média perdidas</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {ins.comparacao.map((c) => (
                <tr key={c.playbook_id} className={cn(c.n < N_MINIMO && "text-muted-foreground")}>
                  <td className="py-2 font-medium">{playbooks.find((x) => x.id === c.playbook_id)?.nome}</td>
                  <td className="text-right font-mono">{c.n}</td>
                  <td className="text-right font-mono">{c.auc?.toFixed(2) ?? "—"}</td>
                  <td className="text-right font-mono">{c.correlacao?.toFixed(2) ?? "—"}</td>
                  <td className="text-right font-mono">{c.media_ganho == null ? "—" : Math.round(c.media_ganho)}</td>
                  <td className="text-right font-mono">{c.media_perdido == null ? "—" : Math.round(c.media_perdido)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {ins.comparacao.some((c) => c.n < N_MINIMO) && <p className="mt-3 text-xs text-muted-foreground">Menos de {N_MINIMO} calls em comum: ainda não dá para dizer qual playbook prevê melhor.</p>}
        </section>
      )}
    </div>
  );
}

function Veredito({ pred }: { pred: Predicao }) {
  const amostraOk = pred.n >= N_MINIMO;
  let texto: string;
  let tom: "ok" | "warn" | "crit" = "warn";
  if (pred.auc == null) texto = "Precisa de pelo menos uma call ganha e uma perdida para comparar.";
  else if (!amostraOk) texto = `Amostra pequena (${pred.n} calls). Leia como tendência, não como conclusão.`;
  else if (pred.auc >= 0.65) {
    texto = "A nota separa bem ganho de perdido: seguir o playbook está associado a vender mais.";
    tom = "ok";
  } else if (pred.auc >= 0.55) texto = "Relação fraca entre nota e venda. Vale revisar as etapas que não mudam a conversão.";
  else {
    texto = "A nota não prevê a venda. Pode ser o playbook (ou o critério de avaliação), não o closer.";
    tom = "crit";
  }
  return (
    <section className={cn("panel flex flex-wrap items-center gap-x-8 gap-y-3 border-l-4 p-4", tom === "ok" ? "border-l-ok" : tom === "crit" ? "border-l-crit" : "border-l-warn")}>
      <p className="min-w-[260px] flex-1 text-sm font-medium">{texto}</p>
      <dl className="flex gap-6 font-mono text-xs">
        <div><dt className="text-muted-foreground">nota média ganhas</dt><dd className="text-lg">{pred.media_ganho == null ? "—" : Math.round(pred.media_ganho)}</dd></div>
        <div><dt className="text-muted-foreground">perdidas</dt><dd className="text-lg">{pred.media_perdido == null ? "—" : Math.round(pred.media_perdido)}</dd></div>
        <div><dt className="text-muted-foreground">correlação</dt><dd className="text-lg">{pred.correlacao?.toFixed(2) ?? "—"}</dd></div>
      </dl>
    </section>
  );
}

/** Taxa de conversão por grupo; valor e n sempre escritos (cor não é a única pista). */
function Bars({ grupos }: { grupos: Grupo[] }) {
  return (
    <div className="space-y-1.5">
      {grupos.map((g, i) => (
        <div
          key={i}
          className={cn("grid grid-cols-[130px_1fr_92px] items-center gap-3 text-sm", g.pequeno && "opacity-55")}
          title={`${g.label}: ${g.ganhas} ganha(s) de ${g.n}${g.pequeno ? ` · amostra pequena (< ${N_MINIMO})` : ""}`}
        >
          <span className="truncate">{g.label}</span>
          <div className="h-4 overflow-hidden rounded-r-[4px] bg-muted">
            {g.conversao != null && <div className="h-full rounded-r-[4px] bg-primary" style={{ width: `${Math.max(g.conversao * 100, g.conversao ? 1.5 : 0)}%` }} />}
          </div>
          <span className="text-right font-mono text-xs">
            <b>{pct(g.conversao)}</b> <span className="text-muted-foreground">n={g.n}</span>
          </span>
        </div>
      ))}
    </div>
  );
}
