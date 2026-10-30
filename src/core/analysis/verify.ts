import { normName } from "../config";
import { requiresLeadEvidence, type Playbook } from "../playbook";
import { notaPorStatus } from "./score";
import type { Role, Segment } from "../types";
import type { AnalysisOutput, VerifiedAnalysis } from "./schema";

export const MATCH_THRESHOLD = 0.85;
export const SEGMENT_TOLERANCE = 2;

export type Match = { score: number; idx: number; role: Role } | undefined;

const tokens = (s: string) => normName(s).split(" ").filter(Boolean);

/** Distância de edição entre listas de palavras. */
function wordLevenshtein(a: string[], b: string[]): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Melhor similaridade (0..1) entre a citação e algum trecho contíguo do texto.
 * Janelas de tamanho n-1..n+1 palavras; só calcula edição onde há sobreposição suficiente de palavras.
 */
export function bestWindowScore(citacao: string, texto: string): number {
  const c = tokens(citacao);
  const t = tokens(texto);
  if (!c.length || !t.length) return 0;
  const joinedC = c.join(" ");
  if (` ${t.join(" ")} `.includes(` ${joinedC} `)) return 1;
  const cset = new Map<string, number>();
  for (const w of c) cset.set(w, (cset.get(w) ?? 0) + 1);
  let best = 0;
  for (let size = Math.max(1, c.length - 1); size <= c.length + 1; size++) {
    for (let i = 0; i + size <= t.length; i++) {
      const win = t.slice(i, i + size);
      const counts = new Map(cset);
      let overlap = 0;
      for (const w of win) {
        const n = counts.get(w);
        if (n) {
          overlap++;
          counts.set(w, n - 1);
        }
      }
      if (overlap / c.length < MATCH_THRESHOLD - 0.1) continue;
      const score = 1 - wordLevenshtein(c, win) / Math.max(c.length, size);
      if (score > best) best = score;
      if (best === 1) return 1;
    }
  }
  // Citação maior que a fala inteira (ex.: fala curta citada com uma palavra a mais)
  if (t.length < c.length - 1) best = Math.max(best, 1 - wordLevenshtein(c, t) / c.length);
  return best;
}

/**
 * Procura a citação no segmento indicado e nos vizinhos (±2), também atravessando a
 * fronteira entre dois segmentos seguidos. Bastidor e ruído não valem como evidência.
 */
export function findQuote(segs: Segment[], citacao: string, idx: number | undefined): Match {
  if (!citacao?.trim() || idx === undefined || !Number.isFinite(idx)) return undefined;
  const usable = (s?: Segment) => s && !s.flags?.length;
  let best: Match;
  for (let i = idx - SEGMENT_TOLERANCE; i <= idx + SEGMENT_TOLERANCE; i++) {
    const s = segs[i];
    if (!usable(s)) continue;
    const consider = (score: number) => {
      // desempate: preferir o segmento indicado
      if (!best || score > best.score || (score === best.score && Math.abs(i - idx) < Math.abs(best.idx - idx)))
        best = { score, idx: i, role: s!.role };
    };
    consider(bestWindowScore(citacao, s!.text));
    const next = segs[i + 1];
    if (usable(next) && i + 1 <= idx + SEGMENT_TOLERANCE) consider(bestWindowScore(citacao, `${s!.text} ${next!.text}`));
  }
  return best && best.score >= MATCH_THRESHOLD ? best : undefined;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));

/**
 * Aplica "sem evidência, não conta": descarta citações que não existem na transcrição,
 * rebaixa etapas sem evidência válida, corrige quem quantificou pelo papel real do falante
 * e recalcula a nota de aderência em código.
 */
export function verifyAnalysis(raw: AnalysisOutput, segs: Segment[], playbook: Playbook): VerifiedAnalysis {
  const a: AnalysisOutput = structuredClone(raw);
  const descartes: VerifiedAnalysis["verificacao"]["descartes"] = [];
  const rebaixadas: VerifiedAnalysis["verificacao"]["etapas_rebaixadas"] = [];
  let total = 0;

  const check = (onde: string, citacao: string | undefined, idx: number | undefined): Match => {
    if (!citacao?.trim()) return undefined;
    total++;
    const m = findQuote(segs, citacao, idx);
    if (!m) descartes.push({ onde, citacao, segment_idx: idx, motivo: "citação não encontrada no trecho indicado (±2 falas)" });
    return m;
  };

  // Etapas: sempre todas as do playbook, na ordem do playbook.
  const byId = new Map(a.etapas.map((e) => [e.id, e]));
  a.etapas = playbook.etapas.map((pe) => {
    const e = byId.get(pe.id) ?? {
      id: pe.id, status: "ausente" as const, nota_0a10: 0, evidencias: [], o_que_faltou: "Etapa não avaliada pelo modelo.", pergunta_sugerida: pe.perguntas_exemplo[0] ?? "",
    };
    const valid: Array<{ citacao: string; segment_idx: number; role: Role }> = [];
    for (const ev of e.evidencias) {
      const m = check(`etapa:${pe.id}`, ev.citacao, ev.segment_idx);
      if (m) valid.push({ citacao: ev.citacao, segment_idx: m.idx, role: m.role });
    }
    let status = e.status;
    let nota = clamp(e.nota_0a10, 0, 10);
    const demote = (para: typeof status, motivo: string) => {
      rebaixadas.push({ id: pe.id, de: status, para, motivo });
      status = para;
    };
    if (status !== "ausente" && valid.length === 0) demote("ausente", "nenhuma evidência válida");
    else if (status === "completo" && requiresLeadEvidence(playbook, pe) && !valid.some((v) => v.role === "cliente"))
      demote("parcial", "sem evidência vinda de fala do lead");
    if (status === "ausente") nota = 0;
    else if (status === "parcial") nota = Math.min(nota, 6);
    return { ...e, id: pe.id, status, nota_0a10: nota, evidencias: valid.map(({ citacao, segment_idx }) => ({ citacao, segment_idx })) };
  });

  // Nota só pelo status (completo 10 · parcial 5 · ausente 0): a nota 0–10 do modelo fica registrada, mas não pesa.
  const nota = notaPorStatus(Object.fromEntries(a.etapas.map((e) => [e.id, e.status])), playbook);

  a.objecoes = a.objecoes.filter((o) => {
    const m = check(`objecao:${o.tipo}`, o.citacao, o.segment_idx);
    if (m) o.segment_idx = m.idx;
    return !!m;
  });

  if (a.reframe.ocorreu) {
    const m = check("reframe", a.reframe.citacao, a.reframe.segment_idx);
    if (m) a.reframe.segment_idx = m.idx;
    else a.reframe = { ocorreu: false, qualidade_0a3: 0 };
  }
  a.reframe.qualidade_0a3 = clamp(Math.round(a.reframe.qualidade_0a3), 0, 3);

  if (a.custo_da_inacao.quantificado) {
    const m = check("custo_da_inacao", a.custo_da_inacao.citacao, a.custo_da_inacao.segment_idx);
    if (!m) a.custo_da_inacao = { quantificado: false };
    else {
      a.custo_da_inacao.segment_idx = m.idx;
      // quem quantificou = papel real de quem falou (determinístico)
      if (m.role === "cliente") a.custo_da_inacao.quem_quantificou = "lead";
      else if (m.role === "closer") a.custo_da_inacao.quem_quantificou = "closer";
    }
  }

  a.sentimento_cliente.momentos = a.sentimento_cliente.momentos.filter((mo) => {
    const m = check("sentimento", mo.citacao, mo.segment_idx);
    if (m) mo.segment_idx = m.idx;
    return !!m;
  });

  // Risco de churn é algo que alguém da Make disse; citação do lead não serve.
  a.risco_churn = a.risco_churn.filter((r) => {
    const m = check(`churn:${r.tipo}`, r.citacao, r.segment_idx);
    if (m && m.role === "cliente") {
      descartes.push({ onde: `churn:${r.tipo}`, citacao: r.citacao, segment_idx: r.segment_idx, motivo: "citação é fala do lead, não da Make" });
      return false;
    }
    if (m) r.segment_idx = m.idx;
    return !!m;
  });

  // Próximo passo continua valendo sem citação; citação inválida é removida.
  for (const p of a.proximos_passos) {
    if (!p.citacao) continue;
    if (!findQuote(segs, p.citacao, nearestIdx(segs, p.citacao))) {
      descartes.push({ onde: "proximo_passo", citacao: p.citacao, motivo: "citação não encontrada" });
      delete p.citacao;
    }
    total++;
  }

  a.coaching.pontos_fortes = a.coaching.pontos_fortes.slice(0, 3);
  a.coaching.melhorias = a.coaching.melhorias.slice(0, 3);
  a.perguntas_closer.abertas = Math.max(0, Math.round(a.perguntas_closer.abertas));
  a.perguntas_closer.fechadas = Math.max(0, Math.round(a.perguntas_closer.fechadas));

  const nota_llm = clamp(raw.nota_aderencia_0a100, 0, 100);
  a.nota_aderencia_0a100 = Math.round(nota * 10) / 10;
  return {
    ...a,
    verificacao: { citacoes_total: total, citacoes_descartadas: descartes.length, descartes, etapas_rebaixadas: rebaixadas, nota_llm },
  };
}

/** Próximos passos vêm sem segment_idx: procura o segmento mais parecido na call toda. */
function nearestIdx(segs: Segment[], citacao: string): number | undefined {
  let best = { score: 0, idx: -1 };
  for (const s of segs) {
    if (s.flags?.length) continue;
    const score = bestWindowScore(citacao, s.text);
    if (score > best.score) best = { score, idx: s.idx };
  }
  return best.idx >= 0 ? best.idx : undefined;
}
