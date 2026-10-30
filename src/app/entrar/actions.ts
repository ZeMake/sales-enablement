"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { COOKIE_ACESSO, iguais, tokenDeAcesso } from "@/lib/acesso";

export async function entrar(_: { erro?: string } | undefined, form: FormData): Promise<{ erro?: string }> {
  const senha = process.env.SITE_PASSWORD;
  const digitada = String(form.get("senha") ?? "");
  const email = String(form.get("email") ?? "");
  const destino = String(form.get("de") ?? "/calls");
  if (!senha) redirect("/calls");
  // Compara login + senha juntos: a mensagem não revela qual dos dois está errado.
  if (!iguais(await tokenDeAcesso(digitada, email), await tokenDeAcesso(senha))) {
    await new Promise((r) => setTimeout(r, 600)); // freia tentativa e erro
    return { erro: "E-mail ou senha incorretos." };
  }
  (await cookies()).set(COOKIE_ACESSO, await tokenDeAcesso(senha), { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: 60 * 60 * 24 * 30 });
  // Só redireciona para caminhos internos (evita mandar alguém para fora do painel).
  redirect(destino.startsWith("/") && !destino.startsWith("//") ? destino : "/calls");
}
