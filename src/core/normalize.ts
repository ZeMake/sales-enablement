import { matchPerson, normName, type Team, type Rules } from "./config";
import type { CallMetrics, RawSegment, Role, Segment } from "./types";

export const wordCount = (s: string) => (s.match(/\S+/g) ?? []).length;

/** Gente da Make que não é closer (pré-vendas, especialista, SDR) costuma se apresentar assim. */
const MAKE_STAFF_SIGNALS = [
  /\baqui da make\b/i,
  /\bnosso closer\b/i,
  /\ba make,? ela [ée]\b/i,
  /\bsou (?:o|a) \p{L}+,? (?:sou )?(?:especialista|closer|consultora?|sdr|gerente)\b/iu,
];

export type RoleAssignment = {
  closerId?: string;
  closerSpeaker?: string;
  roles: Record<string, Role>;
  metodo: Record<string, "time" | "heuristica" | "llm" | "padrao">;
};

/**
 * Papel de cada falante: 1) time (team.yaml) — o closer do time com mais fala é o closer da call,
 * demais pessoas do time viram "outro"; 2) papéis vindos do LLM (quando houver); 3) sinais de
 * apresentação da Make → "outro"; 4) o resto é cliente.
 */
export function assignRoles(
  raw: RawSegment[],
  team: Team,
  opts: { closerHint?: string; llmRoles?: Record<string, Role> } = {},
): RoleAssignment {
  const words = new Map<string, number>();
  const texts = new Map<string, string[]>();
  for (const s of raw) {
    words.set(s.speaker, (words.get(s.speaker) ?? 0) + wordCount(s.text));
    texts.set(s.speaker, [...(texts.get(s.speaker) ?? []), s.text]);
  }
  const speakers = [...words.keys()];

  const teamMatches = speakers
    .map((sp) => ({ sp, person: matchPerson(team, sp) }))
    .filter((m) => m.person?.papeis.includes("closer"));
  const hinted = opts.closerHint ? teamMatches.find((m) => m.person!.id === opts.closerHint) : undefined;
  const main = hinted ?? teamMatches.sort((a, b) => words.get(b.sp)! - words.get(a.sp)!)[0];

  const roles: Record<string, Role> = {};
  const metodo: RoleAssignment["metodo"] = {};
  for (const sp of speakers) {
    const person = matchPerson(team, sp);
    if (main && sp === main.sp) {
      roles[sp] = "closer";
      metodo[sp] = "time";
    } else if (person) {
      roles[sp] = "outro";
      metodo[sp] = "time";
    } else if (opts.llmRoles?.[sp]) {
      roles[sp] = opts.llmRoles[sp];
      metodo[sp] = "llm";
    } else if (texts.get(sp)!.some((t) => MAKE_STAFF_SIGNALS.some((re) => re.test(t)))) {
      roles[sp] = "outro";
      metodo[sp] = "heuristica";
    } else {
      roles[sp] = "cliente";
      metodo[sp] = "padrao";
    }
  }
  // Sem closer do time identificado, o LLM pode apontar o closer.
  if (!main && opts.llmRoles) {
    for (const [sp, r] of Object.entries(opts.llmRoles)) if (r === "closer" && roles[sp]) roles[sp] = "closer";
  }
  return { closerId: main?.person?.id ?? opts.closerHint, closerSpeaker: main?.sp, roles, metodo };
}

/** Texto repetitivo (alucinação de ASR, conversa de fundo em loop): poucos trigramas distintos. */
export function isNoise(text: string, rules: Rules["ingestao"]["ruido"]): boolean {
  const w = normName(text).split(" ").filter(Boolean);
  if (w.length < rules.min_palavras) return false;
  const tri = new Set<string>();
  for (let i = 0; i + 2 < w.length; i++) tri.add(`${w[i]} ${w[i + 1]} ${w[i + 2]}`);
  return tri.size / (w.length - 2) < rules.max_trigramas_unicos;
}

const GREETING = /\b(oi|ol[aá]|bom dia|boa tarde|boa noite|fala|tudo bem|tudo bom|prazer)\b/i;

/**
 * Índice onde a call começa de fato: primeira fala do cliente, recuando até 3 falas
 * quando elas são o cumprimento dirigido ao lead. Antes disso é bastidor (espera, conversa interna).
 */
export function findCallStart(segs: Pick<Segment, "role" | "text" | "speaker">[]): number {
  const first = segs.findIndex((s) => s.role === "cliente");
  if (first <= 0) return Math.max(first, 0);
  const leadFirst = normName(segs[first].speaker).split(" ")[0].slice(0, 4);
  let start = first;
  for (let i = first - 1; i >= Math.max(0, first - 3); i--) {
    const t = segs[i].text;
    const namesLead = leadFirst.length >= 3 && normName(t).includes(leadFirst);
    if (GREETING.test(t) || namesLead) start = i;
    else break;
  }
  return start;
}

/**
 * Preenche start/end. Com timestamps do arquivo, usa-os. Sem eles, distribui a duração
 * (do vídeo, ou estimada por palavras/minuto) proporcionalmente às palavras de cada fala.
 */
export function assignTimes(
  raw: RawSegment[],
  opts: { durationSec?: number; wpm: number },
): { times: Array<{ start: number; end: number }>; estimado: boolean } {
  if (raw.length && raw.every((s) => s.start !== undefined)) {
    const times = raw.map((s, i) => ({
      start: s.start!,
      end: s.end ?? raw[i + 1]?.start ?? s.start! + wordCount(s.text) / (opts.wpm / 60),
    }));
    return { times, estimado: false };
  }
  const weights = raw.map((s) => wordCount(s.text) + 2); // +2 ≈ pausa entre falas
  const total = weights.reduce((a, b) => a + b, 0) || 1;
  const duration = opts.durationSec ?? (total / opts.wpm) * 60;
  let t = 0;
  const times = weights.map((w) => {
    const start = t;
    t += (w / total) * duration;
    return { start: round1(start), end: round1(t) };
  });
  return { times, estimado: true };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function countQuestions(text: string): number {
  return (text.match(/\?+/g) ?? []).length;
}

/** Métricas determinísticas. Ignoram bastidor e ruído. */
export function computeMetrics(segs: Segment[], estimado: boolean): CallMetrics {
  const valid = segs.filter((s) => !s.flags?.length);
  const dur = (s: Segment) => Math.max(0, (s.end ?? 0) - (s.start ?? 0));
  const zero = (): Record<Role, number> => ({ closer: 0, cliente: 0, outro: 0 });
  const tempo = zero();
  const palavras = zero();
  const perguntas = { closer: 0, cliente: 0 };
  for (const s of valid) {
    tempo[s.role] += dur(s);
    palavras[s.role] += wordCount(s.text);
    if (s.role === "closer" || s.role === "cliente") perguntas[s.role] += countQuestions(s.text);
  }
  const totalTempo = tempo.closer + tempo.cliente + tempo.outro;
  const totalPal = palavras.closer + palavras.cliente + palavras.outro;
  const useTempo = totalTempo > 0;
  const fala_pct = zero();
  for (const r of ["closer", "cliente", "outro"] as Role[])
    fala_pct[r] = useTempo ? tempo[r] / totalTempo : totalPal ? palavras[r] / totalPal : 0;

  // Monólogo: falas seguidas do closer; interjeições curtas do cliente ("aham", "sim") não interrompem.
  let longest = 0;
  let cur = 0;
  for (const s of valid) {
    if (s.role === "closer") cur += dur(s);
    else if (wordCount(s.text) > 3) cur = 0;
    longest = Math.max(longest, cur);
  }

  const last = segs[segs.length - 1];
  return {
    duracao_total_seg: round1(last?.end ?? 0),
    duracao_efetiva_seg: round1(totalTempo),
    tempo_estimado: estimado,
    fala_pct,
    palavras,
    maior_monologo_closer_seg: round1(longest),
    perguntas,
    segmentos: segs.length,
    segmentos_bastidor: segs.filter((s) => s.flags?.includes("bastidor")).length,
    segmentos_ruido: segs.filter((s) => s.flags?.includes("ruido")).length,
  };
}

/** Monta os segments canônicos: papéis, flags e tempos. */
export function buildSegments(
  raw: RawSegment[],
  roles: Record<string, Role>,
  opts: { durationSec?: number; rules: Rules },
): { segments: Segment[]; estimado: boolean; startIdx: number } {
  const { times, estimado } = assignTimes(raw, {
    durationSec: opts.durationSec,
    wpm: opts.rules.ingestao.palavras_por_minuto,
  });
  const segments: Segment[] = raw.map((s, idx) => ({
    idx,
    speaker: s.speaker,
    role: roles[s.speaker] ?? "cliente",
    start: times[idx].start,
    end: times[idx].end,
    text: s.text,
  }));
  const startIdx = findCallStart(segments);
  for (const s of segments) {
    const flags: Segment["flags"] = [];
    if (s.idx < startIdx) flags.push("bastidor");
    if (isNoise(s.text, opts.rules.ingestao.ruido)) flags.push("ruido");
    if (flags.length) s.flags = flags;
  }
  return { segments, estimado, startIdx };
}
