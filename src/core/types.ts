import { z } from "zod";

export const ROLES = ["closer", "cliente", "outro"] as const;
export type Role = (typeof ROLES)[number];

export type SegmentFlag = "bastidor" | "ruido";

export type Segment = {
  idx: number;
  speaker: string;
  role: Role;
  start?: number; // segundos
  end?: number;
  text: string;
  flags?: SegmentFlag[];
};

/** Saída de um parser, antes de papéis e tempos. */
export type RawSegment = {
  speaker: string;
  text: string;
  start?: number;
  end?: number;
};

export const TIPOS_CALL = ["diagnostico", "fechamento", "follow_up", "outro"] as const;
export const DESFECHOS = ["ganho", "perdido", "em_andamento", "no_show"] as const;

/** Metadados de negócio da call (manifest.csv ou inferidos). Todos editáveis depois. */
export const CallMetaSchema = z.object({
  call_id: z.string().min(1),
  closer: z.string().optional(),
  gestor: z.string().optional(),
  data_hora: z.string().optional(),
  lead_nome: z.string().optional(),
  empresa: z.string().optional(),
  produto: z.string().optional(),
  tipo_call: z.enum(TIPOS_CALL).optional(),
  desfecho: z.enum(DESFECHOS).optional(),
  valor_venda: z.number().optional(),
  crm_url: z.string().optional(),
  obs: z.string().optional(),
});
export type CallMeta = z.infer<typeof CallMetaSchema>;

export type TriageStatus = "comercial" | "nao_comercial" | "pendente";

export type Triage = {
  status: TriageStatus;
  motivo: string;
  metodo: "llm" | "heuristica" | "regra";
};

export type CallMetrics = {
  duracao_total_seg: number;
  duracao_efetiva_seg: number; // sem bastidor
  tempo_estimado: boolean;
  fala_pct: Record<Role, number>; // por tempo, 0..1
  palavras: Record<Role, number>;
  maior_monologo_closer_seg: number;
  perguntas: { closer: number; cliente: number };
  segmentos: number;
  segmentos_bastidor: number;
  segmentos_ruido: number;
};
