import type { Metadata } from "next";
// Fontes embutidas (Fontsource): o build não depende de baixar do Google, que falhou na Vercel.
import "@fontsource/anton/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-sans/latin-700.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@fontsource/ibm-plex-mono/latin-500.css";
import Link from "next/link";
import { Suspense } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MakeLogo } from "@/components/brand/make-logo";
import { cookies } from "next/headers";
import { autenticado, COOKIE_ACESSO, somenteLeitura } from "@/lib/acesso";
import { NavLinks } from "@/components/nav-links";
import { NotificationBell } from "@/components/notification-bell";
import { ThemeToggle } from "@/components/theme-toggle";
import "./globals.css";


export const metadata: Metadata = {
  title: { default: "Sales Enablement · Make", template: "%s · Sales Enablement" },
  description: "Análise das calls dos closers contra o playbook comercial da Make.",
};

// Painel lê o banco a cada requisição.
export const dynamic = "force-dynamic";

// Aplica o tema antes de pintar (evita piscar): escolha salva; sem escolha, escuro (o visual padrão).
const themeScript = `try{var t=localStorage.getItem("tema");document.documentElement.classList.toggle("dark",t?t==="escuro":true)}catch(e){document.documentElement.classList.add("dark")}`;

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Antes do login (versão publicada), o cabeçalho mostra só a marca: nada de navegação nem contagem do banco.
  const logado = await autenticado((await cookies()).get(COOKIE_ACESSO)?.value);
  return (
    <html lang="pt-BR" suppressHydrationWarning className="h-full antialiased">
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col" data-readonly={somenteLeitura() ? "" : undefined}>
        <TooltipProvider delayDuration={150}>
          <header className="sticky top-0 z-30 border-b bg-background/75 backdrop-blur-xl">
            <div className="mx-auto flex h-16 max-w-[1440px] items-center gap-6 px-5">
              <Link href="/calls" className="flex shrink-0 items-center gap-3" aria-label="Sales Enablement · Make">
                <MakeLogo className="h-8 w-auto text-foreground" />
                <span className="hidden h-6 w-px bg-border sm:block" />
                <span className="hidden font-heading text-[17px] uppercase leading-none tracking-wide sm:block">
                  Sales <span className="text-brand">Enablement</span>
                </span>
              </Link>
              {logado && (
                <Suspense>
                  <NavLinks />
                </Suspense>
              )}
              <div className="ml-auto flex items-center gap-2">
                {somenteLeitura() ? (
                  <span className="rounded-full border border-primary/40 bg-primary/10 px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-primary" title="Versão publicada para validação: nada pode ser alterado aqui.">
                    {process.env.ALLOW_ADD_CALL === "true" ? "Validação · adicionar calls" : "Validação · só leitura"}
                  </span>
                ) : (
                  <span className="hidden rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground xl:inline">
                    V1 local · pós-call
                  </span>
                )}
                {logado && (
                  <Suspense>
                    <NotificationBell />
                  </Suspense>
                )}
                <ThemeToggle />
              </div>
            </div>
            <div className="h-px w-full bg-brand opacity-40" />
          </header>
          <main className="rise mx-auto w-full max-w-[1440px] flex-1 px-5 py-7">{children}</main>
        </TooltipProvider>
      </body>
    </html>
  );
}
