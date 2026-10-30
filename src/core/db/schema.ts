/**
 * Schema em SQLite pensado para migrar para Postgres: ids texto, JSON em colunas texto,
 * datas ISO 8601 em texto, booleanos como integer 0/1 (mode: "boolean").
 */
import { sql } from "drizzle-orm";
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const now = () => text().notNull().default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
const json = <T>() => text({ mode: "json" }).$type<T>();

export const people = sqliteTable("people", {
  id: text().primaryKey(),
  nome: text().notNull(),
  papeis: json<string[]>().notNull(),
  gestores: json<string[]>().notNull(),
  aliases: json<string[]>().notNull(),
  whatsapp: text(),
  slack: text(),
  updated_at: now(),
});

export const calls = sqliteTable(
  "calls",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    source_hash: text().notNull(),
    transcript_path: text(),
    video_path: text(),
    media_path: text(),
    // metadados de negócio (editáveis sem reanalisar)
    closer_id: text().references(() => people.id),
    gestor_id: text().references(() => people.id),
    data_hora: text(),
    lead_nome: text(),
    empresa: text(),
    produto: text(),
    tipo_call: text(),
    desfecho: text(),
    valor_venda: real(),
    crm_url: text(),
    obs: text(),
    meta_origem: text().notNull(),
    // ingestão
    closer_speaker: text(),
    speaker_roles: json<Record<string, string>>().notNull(),
    duration_sec: real(),
    tempo_estimado: integer({ mode: "boolean" }).notNull(),
    call_start_idx: integer().notNull(),
    triage_status: text().notNull(), // comercial | nao_comercial | pendente
    triage_motivo: text(),
    triage_metodo: text(),
    metrics: json<Record<string, unknown>>(),
    quality_flags: json<string[]>().notNull(),
    ingested_at: now(),
    updated_at: now(),
  },
  (t) => [uniqueIndex("calls_source_hash").on(t.source_hash), index("calls_closer").on(t.closer_id)],
);

export const segments = sqliteTable(
  "segments",
  {
    call_id: text().notNull().references(() => calls.id, { onDelete: "cascade" }),
    idx: integer().notNull(),
    speaker: text().notNull(),
    role: text().notNull(),
    start: real(),
    end: real(),
    text: text().notNull(),
    flags: json<string[]>(),
  },
  (t) => [primaryKey({ columns: [t.call_id, t.idx] })],
);

// ---- Fase 2 em diante (modeladas desde já) ----

export const analyses = sqliteTable(
  "analyses",
  {
    id: text().primaryKey(),
    call_id: text().notNull().references(() => calls.id, { onDelete: "cascade" }),
    playbook_id: text().notNull(),
    playbook_version: integer().notNull(),
    prompt_version: text().notNull(),
    model: text().notNull(),
    provider: text().notNull(), // api | claude-cli
    billing: text().notNull(), // api | assinatura
    nota_aderencia: real(), // calculada em código a partir das etapas verificadas
    nota_llm: real(), // nota que o modelo deu, antes da verificação
    // Validação da nota (Jev + revisão humana): faixa entre o status do Opus e o do Jev nas etapas divergentes.
    nota_min: real(),
    nota_max: real(),
    validacao: text(), // validada | provisoria | sem_jev
    etapas_em_revisao: json<string[]>(),
    talk_ratio_closer: real(),
    classificacao: text(), // ok | atencao | critica
    motivos: json<string[]>(),
    confianca: text(),
    result: json<Record<string, unknown>>(),
    citacoes_total: integer().default(0),
    citacoes_descartadas: integer().default(0),
    duracao_ms: integer(),
    tokens_input: integer(),
    tokens_output: integer(),
    tokens_cache_read: integer(),
    tokens_cache_write: integer(),
    custo_usd: real(),
    custo_brl: real(),
    created_at: now(),
  },
  (t) => [uniqueIndex("analyses_unique").on(t.call_id, t.playbook_id, t.prompt_version)],
);

export const stage_results = sqliteTable("stage_results", {
  id: integer().primaryKey({ autoIncrement: true }),
  analysis_id: text().notNull().references(() => analyses.id, { onDelete: "cascade" }),
  stage_id: text().notNull(),
  status: text().notNull(),
  nota: real(),
  o_que_faltou: text(),
  pergunta_sugerida: text(),
  rebaixada: integer({ mode: "boolean" }).default(false),
});

export const evidences = sqliteTable("evidences", {
  id: integer().primaryKey({ autoIncrement: true }),
  analysis_id: text().notNull().references(() => analyses.id, { onDelete: "cascade" }),
  kind: text().notNull(), // etapa | objecao | churn | reframe | ...
  ref_id: text(),
  citacao: text().notNull(),
  segment_idx: integer(),
  match_score: real(),
  valida: integer({ mode: "boolean" }).notNull(),
});

export const objections = sqliteTable("objections", {
  id: integer().primaryKey({ autoIncrement: true }),
  analysis_id: text().notNull().references(() => analyses.id, { onDelete: "cascade" }),
  tipo: text().notNull(),
  citacao: text().notNull(),
  segment_idx: integer(),
  tratamento: text(),
  resolvida: integer({ mode: "boolean" }),
});

export const churn_flags = sqliteTable("churn_flags", {
  id: integer().primaryKey({ autoIncrement: true }),
  analysis_id: text().notNull().references(() => analyses.id, { onDelete: "cascade" }),
  severidade: text().notNull(),
  tipo: text().notNull(),
  citacao: text().notNull(),
  segment_idx: integer(),
  por_que_e_risco: text(),
  como_deveria_ter_dito: text(),
});

export const next_steps = sqliteTable("next_steps", {
  id: integer().primaryKey({ autoIncrement: true }),
  call_id: text().notNull().references(() => calls.id, { onDelete: "cascade" }),
  analysis_id: text().references(() => analyses.id, { onDelete: "set null" }),
  responsavel: text(),
  tarefa: text().notNull(),
  prazo: text(),
  citacao: text(),
  status: text().notNull().default("pendente"), // pendente | feito
  updated_at: now(),
});

export const notifications = sqliteTable(
  "notifications",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    canal: text().notNull(), // painel | slack | whatsapp
    destinatario_id: text().references(() => people.id),
    tipo: text().notNull(), // alerta_critica | relatorio_diario | ...
    chave: text(), // deduplicação: a mesma chave não é gerada duas vezes para o mesmo canal
    call_id: text().references(() => calls.id, { onDelete: "set null" }),
    payload: json<Record<string, unknown>>().notNull(),
    dry_run: integer({ mode: "boolean" }).notNull(),
    status: text().notNull(), // gerada | enviada | erro
    erro: text(),
    lida: integer({ mode: "boolean" }).notNull().default(false),
    created_at: now(),
  },
  (t) => [index("notifications_chave").on(t.chave, t.canal)],
);

export const cost_log = sqliteTable("cost_log", {
  id: integer().primaryKey({ autoIncrement: true }),
  call_id: text().references(() => calls.id, { onDelete: "set null" }),
  etapa: text().notNull(), // triagem | analise | ...
  model: text().notNull(),
  billing: text().notNull().default("api"), // api (custo real) | assinatura (custo equivalente)
  batch: integer({ mode: "boolean" }).notNull().default(false),
  tokens_input: integer().notNull(),
  tokens_output: integer().notNull(),
  tokens_cache_read: integer().notNull().default(0),
  tokens_cache_write: integer().notNull().default(0),
  custo_usd: real().notNull(),
  custo_brl: real().notNull(),
  created_at: now(),
});

/** Confiabilidade de cada resultado da análise, julgada por um segundo modelo (Jev). */
export const reliability = sqliteTable(
  "reliability",
  {
    id: integer().primaryKey({ autoIncrement: true }),
    analysis_id: text().notNull().references(() => analyses.id, { onDelete: "cascade" }),
    kind: text().notNull(), // etapa | churn | objecao_existe | objecao_resolvida
    ref: text().notNull(), // id da etapa ou índice do risco/objeção no resultado
    opus: text().notNull(),
    jev: text().notNull(),
    prob: real().notNull(),
    probabilidades: json<Record<string, number>>(),
    nivel: text().notNull(), // alta | media | divergente
    model: text().notNull(),
    contexto: text().notNull(), // completo | trechos
    created_at: now(),
  },
  (t) => [index("reliability_analysis").on(t.analysis_id)],
);

/** Fila de calls adicionadas pelo painel: ingestão + análise rodam em segundo plano, uma por vez. */
export const jobs = sqliteTable("jobs", {
  id: integer().primaryKey({ autoIncrement: true }),
  status: text().notNull(), // na_fila | rodando | concluida | erro
  etapa: text(), // o que está fazendo agora (texto para a tela)
  transcript_url: text(),
  transcript_text: text(), // transcrição colada (não vira arquivo)
  video_url: text(),
  closer: text(),
  desfecho: text(),
  titulo: text(),
  call_id: text(),
  /** Só este playbook (botão "Analisar com…" numa call já ingerida); vazio = todos os ativos. */
  playbook: text(),
  erro: text(),
  custo_usd: real(),
  /** Trava do passo em andamento (ms desde 1970): evita duas execuções do mesmo passo, e paga em dobro. */
  trava_ate: integer(),
  created_at: now(),
  updated_at: now(),
});

/** Teste de estabilidade: reanálises que NÃO substituem a análise oficial da call. */
export const stability_runs = sqliteTable("stability_runs", {
  id: integer().primaryKey({ autoIncrement: true }),
  call_id: text().notNull().references(() => calls.id, { onDelete: "cascade" }),
  playbook_id: text().notNull(),
  prompt_version: text().notNull(),
  rodada: integer().notNull(),
  nota_aderencia: real().notNull(),
  etapas: json<Array<{ id: string; status: string; nota: number }>>().notNull(),
  custo_usd: real().notNull(),
  billing: text().notNull(),
  created_at: now(),
});

export const calibration_labels = sqliteTable("calibration_labels", {
  id: integer().primaryKey({ autoIncrement: true }),
  call_id: text().notNull().references(() => calls.id, { onDelete: "cascade" }),
  playbook_id: text().notNull(),
  stage_id: text().notNull(),
  status: text().notNull(),
  churn: integer({ mode: "boolean" }),
  avaliador: text(),
  created_at: now(),
});
