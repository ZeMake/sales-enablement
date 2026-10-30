import path from "node:path";
import type { RawSegment } from "../types";

// Prefixo "Nome: " — o nome começa com letra, tem até 8 palavras e não é seguido de dígito
// (evita tratar "às 10:30" como falante).
const SPEAKER_LINE = /^(\p{L}[^:\n]{0,79}?):[ \t]+(?!\d)(.*)$/u;

function isSpeakerName(s: string): boolean {
  return s.trim().split(/\s+/).length <= 8;
}

/**
 * txt no formato do CRM: "Nome: fala", uma fala por parágrafo. Linhas sem prefixo continuam a fala anterior.
 * `tempos`: horário de cada linha não vazia (a API do CRM manda à parte); só é usado se a contagem bater.
 */
export function parseTxt(content: string, tempos?: Array<{ start: number; end: number }>): RawSegment[] {
  const out: RawSegment[] = [];
  const linhas = content.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const t = tempos?.length === linhas.length ? tempos : undefined;
  linhas.forEach((line, i) => {
    const m = line.match(SPEAKER_LINE);
    if (m && isSpeakerName(m[1])) {
      out.push({ speaker: m[1].trim(), text: m[2].trim(), ...t?.[i] });
    } else if (out.length) {
      const prev = out[out.length - 1];
      prev.text += " " + line;
      if (t) prev.end = t[i].end;
    } else {
      out.push({ speaker: "desconhecido", text: line, ...t?.[i] });
    }
  });
  return out.filter((s) => s.text.length > 0);
}

function parseClock(t: string): number {
  const parts = t.trim().replace(",", ".").split(":").map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

const CUE_TIME = /^((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{2}[.,]\d{1,3})/;

function splitSpeaker(text: string): { speaker: string; text: string } {
  const v = text.match(/^<v(?:\.[^ >]+)?\s+([^>]+)>(.*)$/s);
  if (v) return { speaker: v[1].trim(), text: v[2].replace(/<\/v>/g, "").trim() };
  const m = text.match(SPEAKER_LINE);
  if (m && isSpeakerName(m[1])) return { speaker: m[1].trim(), text: m[2].trim() };
  return { speaker: "desconhecido", text: text.trim() };
}

/** .vtt e .srt: blocos de cue com tempo; falante via <v Nome> ou "Nome: ". */
export function parseCues(content: string): RawSegment[] {
  const out: RawSegment[] = [];
  const blocks = content.replace(/^﻿/, "").replace(/\r/g, "").split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter(Boolean);
    const ti = lines.findIndex((l) => CUE_TIME.test(l));
    if (ti < 0) continue;
    const [, a, b] = lines[ti].match(CUE_TIME)!;
    const body = lines.slice(ti + 1).join(" ").replace(/<(?!v[ .])(?!\/v)[^>]+>/g, "");
    if (!body.trim()) continue;
    const { speaker, text } = splitSpeaker(body);
    const prev = out[out.length - 1];
    // cues consecutivos do mesmo falante viram uma fala só
    if (prev && prev.speaker === speaker && speaker !== "desconhecido") {
      prev.text += " " + text;
      prev.end = parseClock(b);
    } else {
      out.push({ speaker, text, start: parseClock(a), end: parseClock(b) });
    }
  }
  return out;
}

const pick = (o: Record<string, unknown>, keys: string[]) => keys.map((k) => o[k]).find((v) => v !== undefined && v !== null);

function toSeconds(v: unknown): number | undefined {
  if (typeof v === "number") return v > 100000 ? v / 1000 : v; // ms → s quando claramente em ms
  if (typeof v === "string") return /:/.test(v) ? parseClock(v) : Number(v) || undefined;
  return undefined;
}

/** .json: array de falas ou { segments | utterances | transcript: [...] } com nomes de campo comuns. */
export function parseJson(content: string): RawSegment[] {
  const data = JSON.parse(content) as unknown;
  const arr = Array.isArray(data)
    ? data
    : (pick(data as Record<string, unknown>, ["segments", "utterances", "transcript", "entries"]) as unknown[]);
  if (!Array.isArray(arr)) throw new Error("JSON de transcrição sem lista de falas reconhecível");
  return arr
    .map((item) => {
      const o = item as Record<string, unknown>;
      return {
        speaker: String(pick(o, ["speaker", "speaker_name", "name", "participant", "author"]) ?? "desconhecido"),
        text: String(pick(o, ["text", "content", "transcript", "words"]) ?? "").trim(),
        start: toSeconds(pick(o, ["start", "start_time", "startTime", "begin"])),
        end: toSeconds(pick(o, ["end", "end_time", "endTime", "stop"])),
      };
    })
    .filter((s) => s.text.length > 0);
}

export const TRANSCRIPT_EXTS = [".txt", ".vtt", ".srt", ".json"] as const;

export function parseTranscript(file: string, content: string, tempos?: Array<{ start: number; end: number }>): RawSegment[] {
  const ext = path.extname(file).toLowerCase();
  switch (ext) {
    case ".txt":
      return parseTxt(content, tempos);
    case ".vtt":
    case ".srt":
      return parseCues(content);
    case ".json":
      return parseJson(content);
    default:
      // Link do CRM sem extensão (título com "&" cortado pela API): o arquivo é o .txt de sempre.
      if (/^https?:\/\//i.test(file) && !ext) return parseTxt(content, tempos);
      throw new Error(`Formato de transcrição não suportado: ${ext}`);
  }
}
