"use client";

import { CheckCircle2, CircleAlert, Link2, Loader2, Plus, ScrollText, Sparkles, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useState } from "react";
import { adicionarCall, tentarDeNovo, type EstadoAdicionar } from "@/app/actions";
import type { JobItem } from "@/core/queries";
import { cn } from "@/lib/utils";

const campo = "h-10 w-full rounded-lg border bg-background/60 px-3 text-sm outline-none transition placeholder:text-muted-foreground/60 focus:border-primary/60 focus:ring-2 focus:ring-primary/25";
const rotulo = "mb-1.5 block font-mono text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground";

/** Botão + formulário "Adicionar call". `bloqueio` = motivo para ficar desativado (versão publicada). */
export function AddCall({ closers, bloqueio, restantes, limite }: { closers: Array<{ id: string; nome: string }>; bloqueio?: string; restantes?: number; limite?: number }) {
  const [aberto, setAberto] = useState(false);
  const [modo, setModo] = useState<"link" | "texto">("link");
  // Fecha o formulário quando a call entra na fila (dentro da própria ação, sem efeito colateral).
  const [state, action, pending] = useActionState(async (prev: EstadoAdicionar | undefined, form: FormData) => {
    const r = await adicionarCall(prev, form);
    if (r.ok) setAberto(false);
    return r;
  }, undefined);

  if (bloqueio)
    return (
      <span title={bloqueio} className="inline-flex cursor-not-allowed items-center gap-2 rounded-full border border-dashed px-4 py-2 text-sm text-muted-foreground">
        <Plus className="size-4" /> Adicionar call
      </span>
    );

  return (
    <div className="w-full">
      <div className="flex items-center justify-end gap-3">
        {restantes !== undefined && (
          <span className="font-mono text-[11px] text-muted-foreground" title="Limite diário de calls novas (controle de custo da análise).">
            {restantes} de {limite} hoje
          </span>
        )}
        <button
          type="button"
          disabled={restantes === 0}
          onClick={() => setAberto((v) => !v)}
          className="bg-brand inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold text-white shadow-[0_10px_28px_-12px_var(--brand-from)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {aberto ? <X className="size-4" /> : <Plus className="size-4" />} {aberto ? "Fechar" : "Adicionar call"}
        </button>
      </div>
      {state?.ok && !aberto && (
        <p className="mt-2 flex items-center justify-end gap-1.5 text-sm text-ok">
          <CheckCircle2 className="size-4" /> {state.ok}
        </p>
      )}

      {aberto && (
        <form action={action} className="panel-hero mt-4 p-5 after:hidden">
          <div className="relative grid gap-5 lg:grid-cols-[1.4fr_1fr]">
            <div className="space-y-4">
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className={rotulo}>Transcrição</span>
                  {/* Link do .txt (CRM) ou o texto colado */}
                  <div className="inline-flex rounded-full border p-0.5 text-xs">
                    {(
                      [
                        ["link", "Link", Link2],
                        ["texto", "Colar texto", ScrollText],
                      ] as const
                    ).map(([m, label, Icon]) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setModo(m)}
                        className={cn("inline-flex items-center gap-1.5 rounded-full px-3 py-1 transition", modo === m ? "bg-primary/15 font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}
                      >
                        <Icon className="size-3.5" /> {label}
                      </button>
                    ))}
                  </div>
                </div>
                {modo === "link" ? (
                  <input name="transcricao_link" type="url" required placeholder="https://storage.googleapis.com/makecrm_meet/…/Reunião….txt" className={campo} />
                ) : (
                  <textarea
                    name="transcricao_texto"
                    required
                    rows={7}
                    placeholder={"Nome do closer: fala…\n\nNome do lead: fala…"}
                    className={cn(campo, "h-auto resize-y py-2.5 font-mono text-[12.5px] leading-relaxed")}
                  />
                )}
              </div>
              <div>
                <label className={rotulo} htmlFor="video_link">
                  Link do vídeo <span className="normal-case tracking-normal opacity-70">· opcional</span>
                </label>
                <input id="video_link" name="video_link" type="url" placeholder="https://…/Reunião….webm" className={campo} />
                <p className="mt-1.5 text-[11.5px] text-muted-foreground">
                  {modo === "link" ? "Vazio: procuro o vídeo com o mesmo nome ao lado da transcrição." : "Sem vídeo, a análise funciona; só não dá para ouvir os trechos."}
                </p>
              </div>
            </div>

            <div className="space-y-4">
              <div>
                <label className={rotulo} htmlFor="closer">Closer</label>
                <select id="closer" name="closer" defaultValue="" className={campo}>
                  <option value="">Detectar pela fala</option>
                  {closers.map((c) => (
                    <option key={c.id} value={c.id}>{c.nome}</option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={rotulo} htmlFor="desfecho">Desfecho</label>
                  <select id="desfecho" name="desfecho" defaultValue="" className={campo}>
                    <option value="">Sem desfecho</option>
                    <option value="ganho">Ganho</option>
                    <option value="perdido">Perdido</option>
                    <option value="em_andamento">Em andamento</option>
                    <option value="no_show">No-show</option>
                  </select>
                </div>
                <div>
                  <label className={rotulo} htmlFor="titulo">Título <span className="normal-case tracking-normal opacity-70">· opcional</span></label>
                  <input id="titulo" name="titulo" placeholder="do nome do arquivo" className={campo} />
                </div>
              </div>
              <div className="rounded-lg border border-dashed px-3 py-2.5 text-[12px] leading-relaxed text-muted-foreground">
                Triagem, análise nos dois playbooks, segunda opinião e alertas. Leva uns <b className="text-foreground">5 minutos</b> por call e roda pela assinatura do Claude, uma de cada vez.
              </div>
              {state?.erro && (
                <p className="flex items-start gap-1.5 text-sm text-crit">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" /> {state.erro}
                </p>
              )}
              <button
                disabled={pending}
                className="bg-brand flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-white shadow-[0_10px_30px_-12px_var(--brand-from)] transition hover:brightness-110 disabled:opacity-60"
              >
                {pending ? <Loader2 className="size-4 animate-spin" /> : <Sparkles className="size-4" />} {pending ? "Enviando…" : "Analisar"}
              </button>
            </div>
          </div>
        </form>
      )}
    </div>
  );
}

const ESTADO: Record<string, { label: string; cls: string }> = {
  na_fila: { label: "na fila", cls: "text-muted-foreground" },
  rodando: { label: "processando", cls: "text-primary" },
  concluida: { label: "pronta", cls: "text-ok" },
  erro: { label: "erro", cls: "text-crit" },
};

/**
 * Status das calls adicionadas que ainda pedem atenção (na fila, rodando ou com erro); as prontas já
 * estão na lista. Enquanto alguma estiver na fila ou rodando, a página se atualiza sozinha.
 */
export function JobsPanel({ jobs: todos }: { jobs: JobItem[] }) {
  const jobs = todos.filter((j) => j.status !== "concluida");
  const router = useRouter();
  const ativos = jobs.some((j) => j.status === "na_fila" || j.status === "rodando");
  useEffect(() => {
    if (!ativos) return;
    const t = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(t);
  }, [ativos, router]);
  if (!jobs.length) return null;
  return (
    <section className="panel p-4">
      <div className="mb-3 flex items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">
        {ativos ? <Loader2 className="size-3.5 animate-spin text-primary" /> : <CheckCircle2 className="size-3.5 text-ok" />}
        Adicionadas pelo painel {ativos && "· atualizando sozinho"}
      </div>
      <ul className="divide-y">
        {jobs.map((j) => {
          const e = ESTADO[j.status] ?? ESTADO.na_fila;
          return (
            <li key={j.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 text-sm">
              <span className={cn("w-24 shrink-0 font-mono text-[11px] uppercase tracking-wider", e.cls)}>
                {j.status === "rodando" && <Loader2 className="mr-1 inline size-3 animate-spin" />}
                {e.label}
              </span>
              <span className="min-w-0 flex-1 truncate font-medium">{j.titulo ?? j.call_id ?? "Nova call"}</span>
              {j.status !== "concluida" || j.etapa !== "pronta" ? (
                <span className={cn("text-[12.5px]", j.status === "erro" ? "basis-full text-crit/90 line-clamp-2" : "text-muted-foreground")} title={j.erro ?? undefined}>
                  {j.status === "erro" ? `Falhou: ${resumoErro(j.erro)}` : j.etapa}
                </span>
              ) : null}
              {j.status === "erro" && (
                <form action={tentarDeNovo.bind(null, j.id)}>
                  <button className="rounded-full border border-primary/50 px-3 py-1 text-[12px] font-medium text-primary transition hover:bg-primary/10">Tentar de novo</button>
                </form>
              )}
              {j.status === "concluida" && j.call_id && (
                <Link href={`/calls/${j.call_id}`} className="text-[12.5px] font-medium text-primary hover:underline">
                  abrir →
                </Link>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Mensagem curta para a tela (o detalhe técnico completo fica no título, ao passar o mouse). */
function resumoErro(erro: string | null): string {
  if (!erro) return "erro desconhecido";
  if (/fora do schema|não é JSON|incompleta/i.test(erro)) return "a resposta da IA veio incompleta. Tente de novo.";
  if (/402|créditos/i.test(erro)) return "sem créditos na OpenRouter.";
  if (/abort|timeout|tempo/i.test(erro)) return "a análise passou do tempo limite.";
  return erro.slice(0, 160);
}
