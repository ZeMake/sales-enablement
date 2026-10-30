"use client";

import { LockKeyhole } from "lucide-react";
import { useActionState } from "react";
import { entrar } from "./actions";

export function EntrarForm({ de }: { de: string }) {
  const [state, action, pending] = useActionState(entrar, undefined);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="de" value={de} />
      <label className="block">
        <span className="mb-1.5 block font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">E-mail</span>
        <input
          name="email"
          type="email"
          autoFocus
          required
          autoComplete="username"
          className="h-11 w-full rounded-lg border bg-background/60 px-3.5 text-sm outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/30"
        />
      </label>
      <label className="block">
        <span className="mb-1.5 block font-mono text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground">Senha</span>
        <input
          name="senha"
          type="password"
          required
          autoComplete="current-password"
          className="h-11 w-full rounded-lg border bg-background/60 px-3.5 text-sm outline-none transition focus:border-primary/60 focus:ring-2 focus:ring-primary/30"
        />
      </label>
      {state?.erro && <p className="text-sm text-crit">{state.erro}</p>}
      <button disabled={pending} className="bg-brand flex h-11 w-full items-center justify-center gap-2 rounded-lg text-sm font-semibold text-white shadow-[0_10px_30px_-12px_var(--brand-from)] transition hover:brightness-110 disabled:opacity-60">
        <LockKeyhole className="size-4" /> {pending ? "Entrando…" : "Entrar"}
      </button>
    </form>
  );
}
