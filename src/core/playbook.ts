import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const StageSchema = z.object({
  id: z.string(),
  nome: z.string(),
  objetivo: z.string(),
  completo_quando: z.string(),
  parcial_quando: z.string(),
  sinais_de_evidencia: z.array(z.string()).default([]),
  perguntas_exemplo: z.array(z.string()).default([]),
  peso: z.number().positive().default(1),
  /** Legenda do painel (não vai para a IA): a etapa como pergunta de sala de vendas. */
  em_uma_frase: z.string().optional(),
  /** Legenda do painel (não vai para a IA): por que essa etapa muda o resultado da venda. */
  por_que_importa: z.string().optional(),
  /** Sobrescreve `evidencia_do_lead_obrigatoria` do playbook para esta etapa. */
  evidencia_do_lead: z.boolean().optional(),
});

const ObjectionRefSchema = z.object({
  objecao: z.string(),
  por_tras: z.string().optional(),
  resposta: z.string(),
  devolva: z.string().optional(),
});

export const PlaybookSchema = z.object({
  id: z.string(),
  nome: z.string(),
  versao: z.number(),
  status: z.string().optional(), // "TODO" = não usar
  regra_geral: z.string().optional(),
  /** Etapa só é "completo" com evidência vinda de fala do cliente (regra do SPICED). */
  evidencia_do_lead_obrigatoria: z.boolean().default(false),
  etapas: z.array(StageSchema),
  /** Respostas de referência às objeções comuns (para avaliar o tratamento). */
  objecoes: z.array(ObjectionRefSchema).default([]),
});
export type Playbook = z.infer<typeof PlaybookSchema>;

const DIR = "config/playbooks";

export function loadPlaybooks(root = process.cwd()): Playbook[] {
  const dir = path.join(root, DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".yaml"))
    .sort()
    .map((f) => {
      const res = PlaybookSchema.safeParse(parse(fs.readFileSync(path.join(dir, f), "utf8")));
      if (!res.success) throw new Error(`Playbook inválido ${f}: ${z.prettifyError(res.error)}`);
      return res.data;
    });
}

export const isActive = (p: Playbook) => p.status !== "TODO" && p.etapas.length > 0;

export const requiresLeadEvidence = (p: Playbook, stage: Playbook["etapas"][number]) =>
  stage.evidencia_do_lead ?? p.evidencia_do_lead_obrigatoria;

/** Texto do playbook para o prompt (estável entre calls, para aproveitar o cache). */
export function renderPlaybook(p: Playbook): string {
  const lines = [`Playbook: ${p.nome} (id: ${p.id}, versão ${p.versao})`];
  if (p.regra_geral) lines.push(`Regra geral: ${p.regra_geral.trim()}`);
  for (const e of p.etapas) {
    lines.push(
      "",
      `## Etapa "${e.id}" — ${e.nome} (peso ${e.peso})`,
      `Objetivo: ${e.objetivo.trim()}`,
      `Completo quando: ${e.completo_quando.trim()}`,
      `Parcial quando: ${e.parcial_quando.trim()}`,
      `Ausente: nada disso aconteceu na call.`,
    );
    if (e.sinais_de_evidencia.length) lines.push(`Sinais de evidência: ${e.sinais_de_evidencia.join("; ")}`);
    if (e.perguntas_exemplo.length) lines.push(`Perguntas exemplo: ${e.perguntas_exemplo.join(" | ")}`);
    if (requiresLeadEvidence(p, e)) lines.push(`Evidência obrigatória: fala do lead (não conta o que só o closer disse).`);
  }
  if (p.objecoes.length) {
    lines.push("", "## Objeções comuns e resposta recomendada pelo playbook (use para avaliar o `tratamento`)");
    for (const o of p.objecoes)
      lines.push(`- ${o.objecao}${o.por_tras ? ` (por trás: ${o.por_tras})` : ""} → ${o.resposta}${o.devolva ? ` Devolva: ${o.devolva}` : ""}`);
  }
  return lines.join("\n");
}
