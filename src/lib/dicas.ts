/**
 * Textos de ajuda do painel (tooltips "?"): como ler cada número, em frase completa.
 * Os limites vêm de config/rules.yaml para o texto nunca divergir da regra.
 */
import { loadConfig } from "@/core/config";

export function dicas() {
  const r = loadConfig().rules.classificacao;
  const barra = r.barra_minima_aderencia;
  const fala = Math.round(r.talk_ratio_max_closer * 100);
  return {
    barra,
    fala,
    criticas: `Calls que o gestor precisa revisar. Basta um destes: nota abaixo de ${barra}, closer falando mais de ${fala}% do tempo, nenhuma etapa do playbook completa, ou risco de churn vermelho que a segunda opinião (Jev) não contestou.`,
    atencao: `Calls sem motivo de crítica, mas com sinal amarelo: nota entre ${barra} e ${r.atencao_se.nota_abaixo_de}, risco de churn amarelo, objeção que ficou sem resposta, ou análise com pouca confiança.`,
    provisorias: "A IA principal (Opus) e a segunda opinião (Jev) discordaram em pelo menos uma etapa. A nota aparece com uma faixa (ex.: 50–70) até alguém revisar.",
    desfecho: "Quantas calls viraram venda, entre as que já têm ganho ou perda registrados (o desfecho vem do CRM ou é marcado na call). Calls em andamento não entram na conta.",
    nota: `Nota de 0 a 100 pela aderência ao playbook: cada etapa vale 10 se completa, 5 se parcial e 0 se ausente, ponderada pelo peso da etapa. Abaixo de ${barra} (a barra mínima, ainda provisória) a call fica crítica.`,
    etapas: "Um quadradinho por etapa do playbook, na ordem: verde = completa, amarelo = parcial, cinza = não aconteceu. Passe o mouse em cada um para ver o nome.",
    fala_closer: `Quanto do tempo de conversa foi o closer falando. Acima de ${fala}% fica vermelho: o closer está apresentando mais do que ouvindo, e quem fala mais na call de venda deveria ser o cliente.`,
    status: "Crítica = revisar já · Atenção = sinal amarelo · OK = dentro do esperado. Abra a call para ver o motivo exato.",
    churn: "Churn é o cliente cancelar depois de comprar. Aqui é o risco disso nascer na própria call: o closer prometeu o que a Make não entrega, garantiu resultado, ou deixou o cliente com expectativa errada (prazo, preço, funcionalidade).",
    churn_vermelho: "Risco vermelho: a fala do closer quebra uma regra comercial (ex.: prometer resultado garantido, condição fora da política). Deixa a call crítica, a menos que a segunda opinião conteste.",
    churn_amarelo: "Risco amarelo: a fala cria uma expectativa exagerada ou ambígua que o atendimento vai ter que corrigir depois. Não é crítico, mas vale um toque no closer.",
  };
}

export type Dicas = ReturnType<typeof dicas>;
