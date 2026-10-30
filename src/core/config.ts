import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const PersonSchema = z.object({
  id: z.string(),
  nome: z.string(),
  papeis: z.array(z.enum(["admin", "gestor", "closer"])).min(1),
  gestores: z.array(z.string()).default([]),
  aliases: z.array(z.string()).default([]),
  whatsapp: z.string().default(""),
  slack: z.string().default(""),
});
export type Person = z.infer<typeof PersonSchema>;

const TeamSchema = z.object({ pessoas: z.array(PersonSchema) });
export type Team = z.infer<typeof TeamSchema>;

const RulesSchema = z.object({
  versao: z.number(),
  ingestao: z.object({
    duracao_minima_min: z.number(),
    palavras_por_minuto: z.number(),
    ruido: z.object({ min_palavras: z.number(), max_trigramas_unicos: z.number() }),
  }),
  classificacao: z.object({
    barra_minima_aderencia: z.number(),
    talk_ratio_max_closer: z.number(),
    critica_se: z.object({
      nota_abaixo_da_barra: z.boolean(),
      churn_vermelho: z.boolean(),
      talk_ratio_acima_do_max: z.boolean(),
      nenhuma_etapa_completa: z.boolean(),
    }),
    atencao_se: z.object({
      nota_abaixo_de: z.number(),
      churn_amarelo: z.boolean(),
      objecao_nao_resolvida: z.boolean(),
      confianca_baixa: z.boolean(),
      citacoes_descartadas_acima_de: z.number(),
    }),
  }),
});
export type Rules = z.infer<typeof RulesSchema>;

function loadYaml<T>(file: string, schema: z.ZodType<T>, root: string): T {
  const full = path.join(root, file);
  const data = parse(fs.readFileSync(full, "utf8"));
  const res = schema.safeParse(data);
  if (!res.success) throw new Error(`Config inválida em ${file}: ${z.prettifyError(res.error)}`);
  return res.data;
}

export type Config = { team: Team; rules: Rules };

export function loadConfig(root = process.cwd()): Config {
  const team = loadYaml("config/team.yaml", TeamSchema, root);
  const ids = new Set(team.pessoas.map((p) => p.id));
  for (const p of team.pessoas)
    for (const g of p.gestores)
      if (!ids.has(g)) throw new Error(`team.yaml: gestor "${g}" de ${p.id} não existe`);
  return { team, rules: loadYaml("config/rules.yaml", RulesSchema, root) };
}

/** Normaliza para comparar nomes: minúsculas, sem acento, espaços simples. */
export function normName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Encontra a pessoa do time para um nome de falante. Casa o nome completo com um alias,
 * ou o primeiro nome com um alias de uma palavra (evita "Eli" casar com "Elison").
 */
export function matchPerson(team: Team, speaker: string): Person | undefined {
  const n = normName(speaker);
  const first = n.split(" ")[0];
  for (const p of team.pessoas) {
    for (const a of p.aliases) {
      const na = normName(a);
      if (n === na) return p;
      if (!na.includes(" ") && first === na) return p;
    }
  }
  return undefined;
}

export function closers(team: Team): Person[] {
  return team.pessoas.filter((p) => p.papeis.includes("closer"));
}
