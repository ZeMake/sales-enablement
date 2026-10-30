// Fixtures SINTÉTICAS. Nunca colocar transcrição real nos testes (LGPD).
import type { Rules, Team } from "../src/core/config";

export const team: Team = {
  pessoas: [
    { id: "gestora", nome: "Gestora Teste", papeis: ["admin", "gestor"], gestores: [], aliases: ["Gestora"], whatsapp: "", slack: "" },
    { id: "ana", nome: "Ana Closer", papeis: ["closer"], gestores: ["gestora"], aliases: ["Ana Closer", "Ana"], whatsapp: "", slack: "" },
    { id: "bia", nome: "Bia Vendas", papeis: ["closer"], gestores: ["gestora"], aliases: ["Bia Vendas", "Bia"], whatsapp: "", slack: "" },
  ],
};

export const rules: Rules = {
  versao: 1,
  ingestao: { duracao_minima_min: 5, palavras_por_minuto: 150, ruido: { min_palavras: 25, max_trigramas_unicos: 0.8 } },
  classificacao: {
    barra_minima_aderencia: 60,
    talk_ratio_max_closer: 0.65,
    critica_se: { nota_abaixo_da_barra: true, churn_vermelho: true, talk_ratio_acima_do_max: true, nenhuma_etapa_completa: true },
    atencao_se: { nota_abaixo_de: 70, churn_amarelo: true, objecao_nao_resolvida: true, confianca_baixa: true, citacoes_descartadas_acima_de: 0.3 },
  },
};

export const TXT_CALL = `Ana Closer: Enquanto o cliente não entra, deixa eu ver a agenda de amanhã.

Carlos Lead: Oi, boa tarde!

Ana Closer: Boa tarde, Carlos! Tudo bem? Como vocês captam clientes hoje?

Carlos Lead: Hoje é tudo indicação. A gente fatura uns 80 mil por mês
e quer chegar em 150 mil até dezembro.

Paula SDR: Oi pessoal, sou a Paula, aqui da Make, só vim acompanhar.

Ana Closer: Legal. E o que acontece se não chegar nessa meta? Vocês já tentaram anúncio?

Carlos Lead: Sim.

Ana Closer: E por que não deu certo?
`;

export const VTT_CALL = `WEBVTT

00:00:01.000 --> 00:00:04.500
<v Ana Closer>Bom dia, tudo bem?

00:00:04.500 --> 00:00:06.000
<v Ana Closer>Pode me contar do seu negócio?

00:00:06.200 --> 00:00:12.000
<v Carlos Lead>Claro, temos uma clínica com 3 unidades.
`;

export const SRT_CALL = `1
00:00:01,000 --> 00:00:03,000
Ana Closer: Olá, Carlos!

2
00:00:03,500 --> 00:00:08,250
Carlos Lead: Olá. Às 10:30 tenho outra reunião.
`;
