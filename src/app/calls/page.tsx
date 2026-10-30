import Link from "next/link";
import { Suspense } from "react";
import { ScanSearch, Siren, SlidersHorizontal, TriangleAlert, Trophy } from "lucide-react";
import { Stat, StageChips, StatusBadge, Score, TalkBar } from "@/components/ci/badges";
import { AddCall, JobsPanel } from "@/components/calls/add-call";
import { ComDica, Dica } from "@/components/ci/dica";
import { PageHeader } from "@/components/ci/section";
import { somenteLeitura } from "@/lib/acesso";
import { UrlSelect } from "@/components/ci/url-select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { adicionadasHoje } from "@/core/jobs";
import { getPeople, listCalls, listJobs } from "@/core/queries";
import { dicas } from "@/lib/dicas";
import { DESFECHO_LABEL, dataCurta, mmss } from "@/lib/format";
import { getContext, resolvePlaybook } from "@/lib/server/context";

export const metadata = { title: "Calls" };

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function CallsPage(props: PageProps<"/calls">) {
  const sp = await props.searchParams;
  const { db, viewer, playbooks, barra } = await getContext();
  const playbook = await resolvePlaybook(sp.playbook);
  const [calls, ppl] = await Promise.all([
    listCalls(db, viewer, {
      playbook,
      closer: one(sp.closer),
      produto: one(sp.produto),
      desfecho: one(sp.desfecho),
      status: one(sp.status),
      churn: one(sp.churn) === "1",
      de: one(sp.de),
      ate: one(sp.ate),
    }),
    getPeople(db),
  ]);
  const pb = playbooks.find((p) => p.id === playbook)!;
  const d = dicas();
  const jobs = await listJobs(db);
  const limiteDia = Number(process.env.MAX_CALLS_DIA ?? 0);
  const names = Object.fromEntries(pb.etapas.map((e) => [e.id, e.nome]));
  const produtos = [...new Set((await listCalls(db, viewer, { playbook })).map((c) => c.produto).filter(Boolean))] as string[];
  const criticas = calls.filter((c) => c.analysis?.classificacao === "critica").length;
  const atencao = calls.filter((c) => c.analysis?.classificacao === "atencao").length;
  const provisorias = calls.filter((c) => c.analysis?.validacao === "provisoria").length;
  const ganhas = calls.filter((c) => c.desfecho === "ganho").length;
  const comDesfecho = calls.filter((c) => c.desfecho === "ganho" || c.desfecho === "perdido").length;

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow={`Pós-call · ${pb.nome}`}
        title="Calls"
        accent={String(calls.length)}
        subtitle={<>Barra mínima {barra} (provisória) · clique numa call para ver as evidências, ouvir o trecho e o porquê de cada nota.</>}
        actions={
          <AddCall
            closers={ppl.filter((p) => p.papeis.includes("closer")).map((p) => ({ id: p.id, nome: p.nome }))}
            bloqueio={somenteLeitura() && process.env.ALLOW_ADD_CALL !== "true" ? "Na versão publicada, adicione calls pelo painel local: a análise roda no PC, pela assinatura do Claude. Depois é só republicar." : undefined}
            restantes={limiteDia > 0 ? Math.max(0, limiteDia - (await adicionadasHoje(db))) : undefined}
            limite={limiteDia}
          />
        }
      />

      <JobsPanel jobs={jobs} />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Siren} label="Críticas" value={criticas} tone={criticas ? "crit" : "ok"} hint="precisam de revisão do gestor" dica={d.criticas} />
        <Stat icon={TriangleAlert} label="Em atenção" value={atencao} tone={atencao ? "warn" : undefined} hint="sinais amarelos para revisar" dica={d.atencao} />
        <Stat icon={ScanSearch} label="Notas provisórias" value={provisorias} hint="Opus e Jev discordam em alguma etapa" dica={d.provisorias} />
        <Stat icon={Trophy} label="Vendas" value={`${ganhas}/${comDesfecho}`} hint="ganhas / com ganho ou perda registrado" dica={d.desfecho} />
      </div>

      <Suspense>
        <div className="panel flex flex-wrap items-center gap-2 p-3">
          <span className="flex items-center gap-1.5 px-1 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
            <SlidersHorizontal className="size-3.5 text-primary" /> Filtros
          </span>
          <UrlSelect param="playbook" placeholder="Playbook" fallback={playbook} options={playbooks.map((p) => ({ value: p.id, label: p.nome }))} className="w-[210px]" />
          <UrlSelect param="closer" placeholder="Closer" allLabel="Todos os closers" options={ppl.filter((p) => p.papeis.includes("closer")).map((p) => ({ value: p.id, label: p.nome }))} />
          <UrlSelect param="status" placeholder="Status" allLabel="Todos os status" options={[{ value: "critica", label: "Crítica" }, { value: "atencao", label: "Atenção" }, { value: "ok", label: "OK" }, { value: "nao_analisada", label: "Não analisada" }]} className="w-[150px]" />
          <UrlSelect param="desfecho" placeholder="Desfecho" allLabel="Todo desfecho" options={[...Object.entries(DESFECHO_LABEL).map(([value, label]) => ({ value, label })), { value: "sem", label: "Sem desfecho" }]} className="w-[150px]" />
          {produtos.length > 0 && <UrlSelect param="produto" placeholder="Produto" allLabel="Todos os produtos" options={produtos.map((p) => ({ value: p, label: p }))} className="w-[160px]" />}
          <UrlSelect param="churn" placeholder="Churn" allLabel="Com ou sem churn" options={[{ value: "1", label: "Só com risco de churn" }]} className="w-[180px]" />
        </div>
      </Suspense>

      <div className="panel overflow-hidden">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {(
                [["Data"], ["Closer"], ["Lead"], ["Produto"], ["Nota", d.nota], ["Etapas", d.etapas], ["Fala closer", d.fala_closer], ["Duração"], ["Desfecho", d.desfecho], ["Status", d.status], ["Churn", d.churn]] as Array<[string, string?]>
              ).map(([h, dica]) => (
                <TableHead key={h} className="font-mono text-[10.5px] uppercase tracking-[0.14em]">
                  <span className="inline-flex items-center gap-1">
                    {h}
                    {dica && <Dica>{dica}</Dica>}
                  </span>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {calls.map((c) => {
              const href = `/calls/${c.id}?playbook=${playbook}`;
              return (
                <TableRow key={c.id} className="group relative cursor-pointer">
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    <Link href={href} className="after:absolute after:inset-0" aria-label={`Abrir ${c.id}`}>
                      {dataCurta(c.data)}
                    </Link>
                  </TableCell>
                  <TableCell className="font-medium">{c.closer_nome ?? "—"}</TableCell>
                  <TableCell className="max-w-[220px] truncate">{c.lead}</TableCell>
                  <TableCell className="text-muted-foreground">{c.produto ?? "—"}</TableCell>
                  <TableCell>
                    <Score value={c.analysis?.nota} barra={barra} />
                    {c.analysis?.validacao === "provisoria" && c.analysis.nota_min != null && c.analysis.nota_max != null && (
                      <div className="font-mono text-[10px] text-warn" title="Nota provisória: Opus e Jev discordam em alguma etapa. Faixa entre as duas leituras.">
                        {Math.round(c.analysis.nota_min)}–{Math.round(c.analysis.nota_max)}
                      </div>
                    )}
                  </TableCell>
                  <TableCell>{c.analysis ? <StageChips etapas={c.analysis.etapas} names={names} /> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    <TalkBar closer={c.fala_closer} estimado={c.tempo_estimado} />
                  </TableCell>
                  <TableCell className="font-mono text-xs">{mmss(c.duracao_seg)}</TableCell>
                  <TableCell className="text-sm">{c.desfecho ? DESFECHO_LABEL[c.desfecho] : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>{c.triage_status === "comercial" ? <StatusBadge status={c.analysis?.classificacao} /> : <span className="font-mono text-[11px] text-muted-foreground">não comercial</span>}</TableCell>
                  <TableCell className="space-x-1 whitespace-nowrap font-mono text-[11px]">
                    {c.analysis && c.analysis.churn_vermelho > 0 && (
                      <ComDica dica={d.churn_vermelho}>
                        <span className="relative z-10 rounded bg-crit/15 px-1.5 py-0.5 text-crit">churn ×{c.analysis.churn_vermelho}</span>
                      </ComDica>
                    )}
                    {c.analysis && c.analysis.churn_amarelo > 0 && (
                      <ComDica dica={d.churn_amarelo}>
                        <span className="relative z-10 rounded bg-warn/15 px-1.5 py-0.5 text-warn">⚠ {c.analysis.churn_amarelo}</span>
                      </ComDica>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!calls.length && (
              <TableRow>
                <TableCell colSpan={11} className="py-12 text-center text-muted-foreground">
                  Nenhuma call com esses filtros.
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
      <p className="font-mono text-[11px] text-muted-foreground">* tempo estimado: a transcrição não tem timestamps; a duração do vídeo foi distribuída pelas palavras.</p>
    </div>
  );
}
