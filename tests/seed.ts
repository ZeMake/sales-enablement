// Banco SINTÉTICO já analisado, para testar relatórios, alertas, calibração, insights e custos
// sem passar pela ingestão nem pela IA.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "../src/core/db/client";
import { analyses, calls, churn_flags, cost_log, next_steps, stage_results } from "../src/core/db/schema";
import { syncPeople } from "../src/core/ingest";
import { rules, team } from "./fixtures";

export type SeedCall = {
  id: string;
  closer: string;
  data: string; // ISO
  desfecho?: string;
  playbook?: string;
  nota: number;
  classificacao: "ok" | "atencao" | "critica";
  motivos?: string[];
  etapas: Record<string, "completo" | "parcial" | "ausente">;
  churnVermelho?: number;
  churnAmarelo?: number;
  reframe?: boolean;
  custoInacao?: boolean;
  caseMomento?: "a_pedido" | "proativo" | null;
  steps?: Array<{ tarefa: string; prazo: string | null; status?: string }>;
  custo?: number;
};

export async function tempDb(): Promise<{ db: Db; dir: string; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ci-seed-"));
  const db = await openDb(path.join(dir, "test.db"));
  await syncPeople(db, { team, rules });
  return { db, dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export async function seed(db: Db, list: SeedCall[]) {
  for (const c of list) {
    const pb = c.playbook ?? "spiced";
    const exists = await db.query.calls.findFirst({ where: (t, { eq }) => eq(t.id, c.id) });
    if (!exists)
      await db.insert(calls).values({
        id: c.id, source: "teste", source_hash: `h-${c.id}`, closer_id: c.closer, data_hora: c.data, desfecho: c.desfecho,
        meta_origem: "{}", speaker_roles: { "Lead Teste": "cliente" }, lead_nome: `Lead ${c.id}`, tempo_estimado: true,
        call_start_idx: 0, triage_status: "comercial", quality_flags: [], duration_sec: 1800,
        metrics: { fala_pct: { closer: 0.5, cliente: 0.5, outro: 0 }, perguntas: { closer: 10, cliente: 3 } },
      });
    const id = `${c.id}__${pb}__analysis.v2`;
    const vermelho = Array.from({ length: c.churnVermelho ?? 0 }, () => ({ severidade: "vermelho", tipo: "promessa_de_resultado", citacao: "garanto resultado", segment_idx: 1, por_que_e_risco: "x", como_deveria_ter_dito: "y" }));
    const amarelo = Array.from({ length: c.churnAmarelo ?? 0 }, () => ({ severidade: "amarelo", tipo: "expectativa_desalinhada", citacao: "fica fácil", segment_idx: 2, por_que_e_risco: "x", como_deveria_ter_dito: "y" }));
    const etapas = Object.entries(c.etapas).map(([eid, status]) => ({
      id: eid, status, nota_0a10: status === "completo" ? 9 : status === "parcial" ? 5 : 0,
      evidencias: status === "ausente" ? [] : [{ citacao: `evidência de ${eid}`, segment_idx: 3 }], o_que_faltou: "", pergunta_sugerida: "",
    }));
    await db.insert(analyses).values({
      id, call_id: c.id, playbook_id: pb, playbook_version: 1, prompt_version: "analysis.v2", model: "claude-opus-5-5",
      provider: "claude-cli", billing: "assinatura", nota_aderencia: c.nota, nota_llm: c.nota, talk_ratio_closer: 0.5,
      classificacao: c.classificacao, motivos: c.motivos ?? [], confianca: "alta",
      result: {
        etapas, risco_churn: [...vermelho, ...amarelo], objecoes: [],
        reframe: { ocorreu: !!c.reframe, qualidade_0a3: c.reframe ? 2 : 0 },
        custo_da_inacao: { quantificado: !!c.custoInacao },
        cases: { cliente_pediu: c.caseMomento === "a_pedido", closer_mostrou: !!c.caseMomento, momento: c.caseMomento ?? null },
        coaching: { pontos_fortes: [], melhorias: [] },
        confianca: "alta",
        nota_aderencia_0a100: c.nota,
        verificacao: { citacoes_total: 0, citacoes_descartadas: 0, descartes: [], etapas_rebaixadas: [], nota_llm: c.nota },
      },
      tokens_input: 30_000, tokens_output: 15_000, tokens_cache_read: 10_000, custo_usd: c.custo ?? 0.5, custo_brl: (c.custo ?? 0.5) * 5.4,
    });
    for (const e of etapas) await db.insert(stage_results).values({ analysis_id: id, stage_id: e.id, status: e.status, nota: e.nota_0a10 });
    for (const r of [...vermelho, ...amarelo]) await db.insert(churn_flags).values({ analysis_id: id, ...r });
    for (const s of c.steps ?? []) await db.insert(next_steps).values({ call_id: c.id, analysis_id: id, tarefa: s.tarefa, prazo: s.prazo, status: s.status ?? "pendente", responsavel: "Ana Closer" });
    await db.insert(cost_log).values({
      call_id: c.id, etapa: `analise:${pb}`, model: "claude-opus-5-5", billing: "assinatura", tokens_input: 30_000, tokens_output: 15_000,
      tokens_cache_read: 10_000, custo_usd: c.custo ?? 0.5, custo_brl: (c.custo ?? 0.5) * 5.4, created_at: c.data,
    });
  }
}
