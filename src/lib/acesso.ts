/**
 * Login do painel publicado: e-mail (SITE_LOGIN) + senha (SITE_PASSWORD), definidos só nas variáveis
 * da Vercel. Sem SITE_PASSWORD não há bloqueio (uso local).
 * O cookie guarda um código derivado do login e da senha, nunca a senha; trocar qualquer um derruba os acessos.
 */
export const COOKIE_ACESSO = "se_acesso";

export async function tokenDeAcesso(senha: string, login = process.env.SITE_LOGIN ?? ""): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`sales-enablement:${login.trim().toLowerCase()}:${senha}`));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Comparação em tempo constante (não vaza, pelo tempo de resposta, quantos caracteres batem). */
export function iguais(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export const somenteLeitura = () => process.env.READ_ONLY === "true";

/** Adicionar/analisar call: livre no painel local; na versão publicada (só leitura), só se ALLOW_ADD_CALL=true. */
export const podeAdicionar = () => !somenteLeitura() || process.env.ALLOW_ADD_CALL === "true";

/** Quem está vendo já entrou? Sem SITE_PASSWORD (uso local) é sempre sim. */
export async function autenticado(cookie: string | undefined): Promise<boolean> {
  const senha = process.env.SITE_PASSWORD;
  if (!senha) return true;
  return !!cookie && iguais(cookie, await tokenDeAcesso(senha));
}
