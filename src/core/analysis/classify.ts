import type { Rules } from "../config";
import type { VerifiedAnalysis } from "./schema";

export type Classificacao = "ok" | "atencao" | "critica";

const pct = (n: number) => `${Math.round(n * 100)}%`;

/** "expectativa desalinhada ×3, prazo irreal" — agrupa tipos repetidos, na ordem em que aparecem. */
function tipos(rs: { tipo: string }[]): string {
  const n = new Map<string, number>();
  for (const r of rs) n.set(r.tipo, (n.get(r.tipo) ?? 0) + 1);
  return [...n].map(([t, k]) => `${t.replace(/_/g, " ")}${k > 1 ? ` ×${k}` : ""}`).join(", ");
}

/**
 * Classificação em código a partir do rules.yaml, sempre com a lista de motivos.
 * `churnJev`: nível do Jev por índice do risco. Risco que o Jev não confirma ("divergente") não
 * torna a call crítica; sem Jev rodado, o risco vale como veio da análise.
 */
export function classify(
  a: VerifiedAnalysis,
  ctx: { talkRatioCloser: number; tempoEstimado: boolean; churnJev?: Record<number, string> },
  rules: Rules["classificacao"],
): { classificacao: Classificacao; motivos: string[] } {
  const critica: string[] = [];
  const atencao: string[] = [];
  const c = rules.critica_se;
  const at = rules.atencao_se;
  const nota = a.nota_aderencia_0a100;

  if (c.nota_abaixo_da_barra && nota < rules.barra_minima_aderencia)
    critica.push(`Nota ${Math.round(nota)} abaixo da barra mínima (${rules.barra_minima_aderencia})`);
  const confirmado = (i: number) => ctx.churnJev?.[i] !== "divergente";
  const riscos = a.risco_churn.map((r, i) => ({ ...r, ok: confirmado(i) }));
  const vermelhos = riscos.filter((r) => r.severidade === "vermelho" && r.ok);
  const naoConfirmados = riscos.filter((r) => !r.ok);
  if (c.churn_vermelho && vermelhos.length)
    critica.push(`Risco de churn vermelho${ctx.churnJev && Object.keys(ctx.churnJev).length ? " (confirmado pelo Jev)" : ""}: ${tipos(vermelhos)}`);
  if (c.talk_ratio_acima_do_max && ctx.talkRatioCloser > rules.talk_ratio_max_closer) {
    const fala = `Closer falou ${pct(ctx.talkRatioCloser)} (máx. ${pct(rules.talk_ratio_max_closer)})`;
    // Sem timestamps o % de fala é estimado por palavras: não é medida confiável o bastante
    // para condenar a call. Nesse caso vira só alerta (atenção), nunca motivo de crítica.
    if (ctx.tempoEstimado) atencao.push(`${fala} — tempo estimado, só alerta`);
    else critica.push(fala);
  }
  if (c.nenhuma_etapa_completa && !a.etapas.some((e) => e.status === "completo")) critica.push("Nenhuma etapa completa");

  if (nota >= rules.barra_minima_aderencia && nota < at.nota_abaixo_de) atencao.push(`Nota ${Math.round(nota)} abaixo de ${at.nota_abaixo_de}`);
  const amarelos = riscos.filter((r) => r.severidade === "amarelo" && r.ok);
  if (at.churn_amarelo && amarelos.length) atencao.push(`Risco de churn amarelo: ${tipos(amarelos)}`);
  if (naoConfirmados.length) {
    const verm = naoConfirmados.filter((r) => r.severidade === "vermelho");
    atencao.push(`${naoConfirmados.length} risco(s) de churn não confirmado(s) pelo Jev — revisar${verm.length ? ` (vermelho: ${tipos(verm)})` : ""}`);
  }
  const abertas = a.objecoes.filter((o) => !o.resolvida);
  if (at.objecao_nao_resolvida && abertas.length) atencao.push(`Objeção não resolvida: ${[...new Set(abertas.map((o) => o.tipo))].join(", ")}`);
  if (at.confianca_baixa && a.confianca === "baixa") atencao.push("Confiança da análise baixa");
  const v = a.verificacao;
  if (v.citacoes_total && v.citacoes_descartadas / v.citacoes_total > at.citacoes_descartadas_acima_de)
    atencao.push(`${v.citacoes_descartadas} de ${v.citacoes_total} citações da IA não existiam na transcrição — revisar`);

  if (critica.length) return { classificacao: "critica", motivos: [...critica, ...atencao] };
  if (atencao.length) return { classificacao: "atencao", motivos: atencao };
  return { classificacao: "ok", motivos: [] };
}
