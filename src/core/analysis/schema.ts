import { z } from "zod";

/**
 * Saída da análise (SPEC §7.4). O schema enviado ao modelo evita restrições numéricas e de
 * tamanho (nem todo modo de saída estruturada aceita); limites são aplicados em código.
 */
const Evidence = z.object({ citacao: z.string(), segment_idx: z.number() });

export const AnalysisOutput = z.object({
  playbook_id: z.string(),
  etapas: z.array(
    z.object({
      id: z.string(),
      status: z.enum(["completo", "parcial", "ausente"]),
      nota_0a10: z.number(),
      evidencias: z.array(Evidence),
      o_que_faltou: z.string(),
      pergunta_sugerida: z.string(),
    }),
  ),
  nota_aderencia_0a100: z.number(),
  perguntas_closer: z.object({ abertas: z.number(), fechadas: z.number() }),
  objecoes: z.array(
    z.object({
      tipo: z.enum(["preco", "tempo", "confianca", "decisor", "concorrente", "necessidade", "outro"]),
      citacao: z.string(),
      segment_idx: z.number(),
      tratamento: z.string(),
      resolvida: z.boolean(),
    }),
  ),
  reframe: z.object({
    ocorreu: z.boolean(),
    dor_original: z.string().optional(),
    dor_reposicionada: z.string().optional(),
    citacao: z.string().optional(),
    segment_idx: z.number().optional(),
    qualidade_0a3: z.number(),
  }),
  custo_da_inacao: z.object({
    quantificado: z.boolean(),
    quem_quantificou: z.enum(["lead", "closer"]).optional(),
    valor: z.string().optional(),
    citacao: z.string().optional(),
    segment_idx: z.number().optional(),
  }),
  cases: z.object({
    cliente_pediu: z.boolean(),
    closer_mostrou: z.boolean(),
    momento: z.enum(["a_pedido", "proativo"]).nullable(),
  }),
  sentimento_cliente: z.object({
    geral: z.enum(["entusiasmado", "interessado", "neutro", "resistente", "desinteressado"]),
    sinais_de_compra: z.array(z.string()),
    momentos: z.array(z.object({ segment_idx: z.number(), sentimento: z.string(), citacao: z.string() })),
  }),
  risco_churn: z.array(
    z.object({
      severidade: z.enum(["amarelo", "vermelho"]),
      tipo: z.enum([
        "promessa_de_resultado",
        "prazo_irreal",
        "funcionalidade_inexistente",
        "expectativa_desalinhada",
        "condicao_fora_da_politica",
        "outro",
      ]),
      citacao: z.string(),
      segment_idx: z.number(),
      por_que_e_risco: z.string(),
      como_deveria_ter_dito: z.string(),
    }),
  ),
  resumo: z.object({
    contexto: z.string(),
    dores: z.array(z.string()),
    impacto_financeiro: z.object({ descricao: z.string(), valores: z.array(z.string()) }),
    evento_critico: z.string(),
    decisao: z.object({
      decisores: z.array(z.string()),
      criterios: z.array(z.string()),
      processo: z.string(),
      alternativas_avaliadas: z.array(z.string()),
    }),
  }),
  proximos_passos: z.array(
    z.object({ responsavel: z.string(), tarefa: z.string(), prazo: z.string().optional(), citacao: z.string().optional() }),
  ),
  coaching: z.object({
    pontos_fortes: z.array(z.string()),
    melhorias: z.array(z.object({ ponto: z.string(), exemplo_de_frase: z.string() })),
  }),
  mapa_mental_mermaid: z.string(),
  confianca: z.enum(["alta", "media", "baixa"]),
  observacoes: z.string(),
});
export type AnalysisOutput = z.infer<typeof AnalysisOutput>;

/** Resultado depois da verificação em código. */
export type VerifiedAnalysis = AnalysisOutput & {
  verificacao: {
    citacoes_total: number;
    citacoes_descartadas: number;
    descartes: Array<{ onde: string; citacao: string; segment_idx?: number; motivo: string }>;
    etapas_rebaixadas: Array<{ id: string; de: string; para: string; motivo: string }>;
    nota_llm: number;
  };
};
