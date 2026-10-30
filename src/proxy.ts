import { NextResponse, type NextRequest } from "next/server";
import { COOKIE_ACESSO, iguais, tokenDeAcesso } from "@/lib/acesso";

/** Bloqueia o painel publicado atrás da senha única (SITE_PASSWORD). Local, sem a variável, passa direto. */
export async function proxy(req: NextRequest) {
  const senha = process.env.SITE_PASSWORD;
  if (!senha) return NextResponse.next();
  // A fila (chamada pelo próprio servidor) e o cron do CRM (chamado pela Vercel) têm segredo próprio: a rota confere.
  if (req.nextUrl.pathname === "/api/fila" || req.nextUrl.pathname === "/api/crm/desfechos") return NextResponse.next();
  const cookie = req.cookies.get(COOKIE_ACESSO)?.value ?? "";
  if (cookie && iguais(cookie, await tokenDeAcesso(senha))) return NextResponse.next();
  if (req.nextUrl.pathname.startsWith("/api/")) return new NextResponse("Acesso restrito", { status: 401 });
  const url = req.nextUrl.clone();
  url.pathname = "/entrar";
  url.search = `?de=${encodeURIComponent(req.nextUrl.pathname + req.nextUrl.search)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Tudo, menos a tela de entrada, arquivos do Next e os ícones da marca.
  matcher: ["/((?!entrar|_next/static|_next/image|icon.svg|make-mark.svg|favicon.ico).*)"],
};
