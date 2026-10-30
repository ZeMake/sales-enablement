import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // O painel lê em tempo de execução os YAML de config/ (time, regras, playbooks, produtos) e as
  // migrações em drizzle/ (aplicadas ao abrir o banco). Na Vercel, arquivos lidos por caminho
  // dinâmico não entram sozinhos no pacote da função: inclui à mão em todas as rotas.
  outputFileTracingIncludes: {
    "/**": ["./config/**/*", "./drizzle/**/*", "./snapshot/**/*", "./prompts/**/*"],
  },
  // Fora do pacote das funções: dados locais e os vídeos de public/ (servidos pelo CDN, atrás do login).
  outputFileTracingExcludes: {
    "/**": ["./data/**/*", "./out/**/*", "./public/**/*"],
  },
};

export default nextConfig;
