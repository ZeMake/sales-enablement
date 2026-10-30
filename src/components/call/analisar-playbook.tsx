"use client";

import { Loader2, Sparkles } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { analisarComPlaybook } from "@/app/actions";

/**
 * Botão "Analisar com <playbook>" para um playbook que a call ainda não tem. Enquanto a análise está na
 * fila ou rodando, mostra o andamento e atualiza a página sozinho até a nota aparecer.
 */
export function AnalisarPlaybook({ callId, playbooks, andamento }: { callId: string; playbooks: Array<{ id: string; nome: string }>; andamento?: string }) {
  const router = useRouter();
  const [pendente, start] = useTransition();
  const [erro, setErro] = useState<string>();
  useEffect(() => {
    if (!andamento) return;
    const t = setInterval(() => router.refresh(), 8000);
    return () => clearInterval(t);
  }, [andamento, router]);

  if (andamento)
    return (
      <span className="inline-flex items-center gap-1.5 text-[12.5px] text-primary">
        <Loader2 className="size-3.5 animate-spin" /> {andamento} · leva uns 3 min
      </span>
    );
  return (
    <>
      {playbooks.map((p) => (
        <button
          key={p.id}
          disabled={pendente}
          onClick={() =>
            start(async () => {
              setErro(undefined);
              try {
                await analisarComPlaybook(callId, p.id);
              } catch (e) {
                setErro((e as Error).message);
              }
            })
          }
          className="pill border-dashed border-primary/60 text-primary transition hover:bg-primary/10 disabled:opacity-60"
        >
          {pendente ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />} Analisar com {p.nome}
        </button>
      ))}
      {erro && <span className="text-[12.5px] text-crit">{erro}</span>}
    </>
  );
}
