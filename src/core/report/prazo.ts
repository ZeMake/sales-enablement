/**
 * Converte o prazo em texto livre de um próximo passo ("logo após a call", "sexta-feira",
 * "dia 7", "até o fim da semana") numa data, a partir da data da call.
 *
 * Conservador de propósito: o que for vago ou condicional ("sem prazo", "depois que o
 * material chegar", "logo após receber os dados") devolve null — não inventamos data. Quando o
 * texto cita mais de um prazo ("hoje ou amanhã"), vale o mais tardio: um passo só conta como
 * vencido depois do último prazo plausível.
 */

const DIAS: Array<[RegExp, number]> = [
  [/\bdomingo\b/, 0],
  [/\bsegunda(-feira)?\b/, 1],
  [/\bter[cç]a(-feira)?\b/, 2],
  [/\bquarta(-feira)?\b/, 3],
  [/\bquinta(-feira)?\b/, 4],
  [/\bsexta(-feira)?\b/, 5],
  [/\bs[aá]bado\b/, 6],
];

/** Dia (YYYY-MM-DD) no fuso local. Data com horário e fuso (ex.: ingested_at em UTC) é convertida; sem fuso, vale como está. */
export function localDay(s: string): string {
  if (/T.*(Z|[+-]\d\d:?\d\d)$/.test(s)) {
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString("sv-SE");
  }
  return s.slice(0, 10);
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 864e5);
/** Sexta-feira da semana de `d` (ou a própria, se for sexta; sábado/domingo → a sexta seguinte). */
const sextaDaSemana = (d: Date) => addDays(d, (5 - d.getUTCDay() + 7) % 7);

export function parsePrazo(texto: string | null | undefined, dataCall: string): string | null {
  if (!texto?.trim()) return null;
  const t = texto.toLowerCase();
  if (/sem (prazo|data)|n[aã]o definid|indefinid|a combinar/.test(t)) return null;
  const base = new Date(`${localDay(dataCall)}T12:00:00Z`);
  if (Number.isNaN(base.getTime())) return null;
  const datas: Date[] = [];

  for (const m of t.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) datas.push(new Date(`${m[0]}T12:00:00Z`));
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    const ano = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : base.getUTCFullYear();
    let d = new Date(Date.UTC(ano, Number(m[2]) - 1, Number(m[1]), 12));
    if (!m[3] && d < base) d = new Date(Date.UTC(ano + 1, Number(m[2]) - 1, Number(m[1]), 12));
    datas.push(d);
  }
  if (/\bhoje\b|na hora|mesm[oa] (dia|tarde|manh[aã])|logo ap[oó]s a (call|reuni[aã]o)|ainda hoje/.test(t)) datas.push(base);
  if (/\bamanh[aã](?!\p{L})/u.test(t) && !/v[aá]lid[ao] at[eé] amanh/.test(t)) datas.push(addDays(base, 1));
  for (const [re, dia] of DIAS) if (re.test(t)) datas.push(addDays(base, ((dia - base.getUTCDay() + 7) % 7) || 7));
  if (/fim da (pr[oó]xima )?semana (seguinte|que vem)|fim da pr[oó]xima semana/.test(t)) datas.push(addDays(sextaDaSemana(base), 7));
  else if (/fim da semana|final da semana|esta semana|essa semana/.test(t)) datas.push(sextaDaSemana(base));
  if (/semana que vem|pr[oó]xima semana|\buma semana\b|em 7 dias/.test(t)) datas.push(addDays(base, 7));
  for (const m of t.matchAll(/\b(?:em|at[eé]) (?:at[eé] )?(\d{1,2}) dias\b/g)) datas.push(addDays(base, Number(m[1])));
  if (/m[eê]s que vem|pr[oó]ximo m[eê]s/.test(t)) datas.push(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 2, 0, 12)));
  for (const m of t.matchAll(/\bdia (\d{1,2})\b/g)) {
    const dia = Number(m[1]);
    if (dia < 1 || dia > 31) continue;
    let d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), dia, 12));
    if (d < base) d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, dia, 12));
    datas.push(d);
  }

  if (!datas.length) return null;
  return iso(new Date(Math.max(...datas.map((d) => d.getTime()))));
}
