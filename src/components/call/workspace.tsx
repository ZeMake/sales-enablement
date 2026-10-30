"use client";

import { Activity, ScrollText } from "lucide-react";
import { SectionTitle } from "@/components/ci/section";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Segment } from "@/core/types";
import { mmss } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Marca algo da análise ancorado numa fala (evidência, objeção, churn…). */
export type Marker = { idx: number; kind: "etapa" | "objecao" | "churn" | "reframe" | "custo"; label: string; tone: "ok" | "warn" | "crit" | "lead" | "primary" };

type Ctx = { jump: (idx: number) => void; active: number | null };
const WorkspaceCtx = createContext<Ctx>({ jump: () => {}, active: null });
export const useJump = () => useContext(WorkspaceCtx).jump;

/** Provê "pular para a fala" a qualquer citação dentro dele: rola a transcrição e posiciona o vídeo. */
export function Workspace({ segments, children }: { segments: Segment[]; children: React.ReactNode }) {
  const [active, setActive] = useState<number | null>(null);
  const jump = useCallback(
    (idx: number) => {
      setActive(idx);
      const el = document.getElementById(`seg-${idx}`);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "center" });
        el.classList.remove("seg-flash");
        void el.offsetWidth;
        el.classList.add("seg-flash");
      }
      const video = document.getElementById("call-video") as HTMLVideoElement | null;
      const seg = segments[idx];
      if (video && seg?.start != null) video.currentTime = seg.start;
    },
    [segments],
  );
  return <WorkspaceCtx.Provider value={{ jump, active }}>{children}</WorkspaceCtx.Provider>;
}

/** Citação clicável: o elemento central do "sem evidência, não conta". */
export function Quote({ text, idx, speaker }: { text: string; idx: number; speaker?: string }) {
  const jump = useJump();
  return (
    <button
      type="button"
      onClick={() => jump(idx)}
      className="group block w-full rounded-md border-l-2 border-primary/70 bg-secondary/60 px-3 py-2 text-left text-[13px] leading-relaxed transition-colors hover:bg-accent"
      title="Ir para este trecho na transcrição e no vídeo"
    >
      <span className="italic">“{text}”</span>
      <span className="mt-1 block font-mono text-[10.5px] text-muted-foreground group-hover:text-foreground">
        #{idx}
        {speaker ? ` · ${speaker}` : ""} · ir para o trecho →
      </span>
    </button>
  );
}

const ROLE_COLOR: Record<string, string> = { closer: "var(--closer)", cliente: "var(--lead)", outro: "var(--other)" };
const TONE_COLOR: Record<Marker["tone"], string> = { ok: "var(--ok)", warn: "var(--warn)", crit: "var(--crit)", lead: "var(--lead)", primary: "var(--primary)" };

/** Faixas de quem falou ao longo da call + marcadores da análise. */
export function Timeline({ segments, markers, estimado }: { segments: Segment[]; markers: Marker[]; estimado: boolean }) {
  const jump = useJump();
  const total = segments.at(-1)?.end ?? 1;
  const rows: Array<Segment["role"]> = ["closer", "cliente", "outro"];
  const present = rows.filter((r) => segments.some((s) => s.role === r));
  const rowH = 12;
  const h = present.length * (rowH + 4) + 26;
  const x = (t: number) => (t / total) * 1000;
  const onClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const t = ((e.clientX - rect.left) / rect.width) * total;
    const seg = segments.find((s) => (s.start ?? 0) <= t && (s.end ?? 0) >= t) ?? segments.at(-1);
    if (seg) jump(seg.idx);
  };
  return (
    <div className="panel p-5">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <SectionTitle icon={Activity} title="Linha do tempo" className="mb-0" />
        <div className="flex flex-wrap items-center gap-3 font-mono text-[10.5px] text-muted-foreground">
          {present.map((r) => (
            <span key={r} className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ background: ROLE_COLOR[r] }} />
              {r}
            </span>
          ))}
          <span className="flex items-center gap-1.5"><span className="size-2 rotate-45" style={{ background: TONE_COLOR.ok }} />etapa</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rotate-45" style={{ background: TONE_COLOR.lead }} />objeção</span>
          <span className="flex items-center gap-1.5"><span className="size-2 rotate-45" style={{ background: TONE_COLOR.crit }} />churn</span>
          {estimado && <span>tempo estimado</span>}
        </div>
      </div>
      <svg viewBox={`0 0 1000 ${h}`} preserveAspectRatio="none" className="h-auto w-full cursor-pointer" style={{ height: h }} onClick={onClick} role="img" aria-label="Linha do tempo da conversa">
        {present.map((r, ri) => (
          <g key={r} transform={`translate(0, ${ri * (rowH + 4)})`}>
            <rect x={0} y={0} width={1000} height={rowH} rx={2} fill="currentColor" className="text-muted/60" />
            {segments
              .filter((s) => s.role === r)
              .map((s) => (
                <rect
                  key={s.idx}
                  x={x(s.start ?? 0)}
                  y={0}
                  width={Math.max(0.8, x((s.end ?? 0) - (s.start ?? 0)))}
                  height={rowH}
                  fill={ROLE_COLOR[r]}
                  opacity={s.flags?.length ? 0.25 : 0.9}
                >
                  <title>{`#${s.idx} ${s.speaker} · ${mmss(s.start)}`}</title>
                </rect>
              ))}
          </g>
        ))}
        {markers.map((m, i) => {
          const s = segments[m.idx];
          if (!s) return null;
          const cx = x(((s.start ?? 0) + (s.end ?? 0)) / 2);
          const y = present.length * (rowH + 4) + 8;
          return (
            <g key={i}>
              <line x1={cx} x2={cx} y1={0} y2={y - 4} stroke={TONE_COLOR[m.tone]} strokeOpacity={0.35} strokeWidth={1} vectorEffect="non-scaling-stroke" />
              <rect x={cx - 4} y={y - 4} width={8} height={8} transform={`rotate(45 ${cx} ${y})`} fill={TONE_COLOR[m.tone]}>
                <title>{m.label}</title>
              </rect>
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted-foreground">
        <span>0:00</span>
        <span>{mmss(total / 2)}</span>
        <span>{mmss(total)}</span>
      </div>
    </div>
  );
}

/** Vídeo + transcrição sincronizados. Evidências ficam destacadas na transcrição. */
export function MediaTranscript({
  segments,
  mediaUrl,
  markers,
  estimado,
}: {
  segments: Segment[];
  mediaUrl?: string;
  markers: Marker[];
  estimado: boolean;
}) {
  const { jump, active } = useContext(WorkspaceCtx);
  const [playing, setPlaying] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [q, setQ] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const byIdx = useMemo(() => {
    const m = new Map<number, Marker[]>();
    for (const mk of markers) m.set(mk.idx, [...(m.get(mk.idx) ?? []), mk]);
    return m;
  }, [markers]);

  useEffect(() => {
    if (!follow || playing == null) return;
    const el = document.getElementById(`seg-${playing}`);
    const list = listRef.current;
    if (el && list) list.scrollTo({ top: el.offsetTop - list.clientHeight / 2, behavior: "smooth" });
  }, [playing, follow]);

  const onTime = (e: React.SyntheticEvent<HTMLVideoElement>) => {
    const t = e.currentTarget.currentTime;
    const seg = segments.find((s) => (s.start ?? 0) <= t && (s.end ?? 0) > t);
    if (seg && seg.idx !== playing) setPlaying(seg.idx);
  };
  const needle = q.trim().toLowerCase();

  return (
    <div className="panel flex h-full flex-col overflow-hidden">
      {mediaUrl ? (
        <video id="call-video" src={mediaUrl} controls preload="metadata" className="aspect-video w-full bg-black" onTimeUpdate={onTime} />
      ) : (
        <div className="grid aspect-[16/5] place-items-center bg-muted font-mono text-xs text-muted-foreground">sem vídeo para esta call</div>
      )}
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <SectionTitle icon={ScrollText} title="Transcrição" className="mb-0" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="buscar…"
          className="ml-auto h-7 w-40 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring/40"
        />
        {mediaUrl && (
          <label className="flex items-center gap-1.5 font-mono text-[10.5px] text-muted-foreground">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} className="accent-[var(--primary)]" />
            seguir vídeo
          </label>
        )}
      </div>
      {estimado && mediaUrl && (
        <p className="border-b bg-warn/10 px-3 py-1.5 text-[11px] text-muted-foreground">Sem timestamps na transcrição: o salto para o vídeo é aproximado (±30 s).</p>
      )}
      <div ref={listRef} className="relative flex-1 space-y-0.5 overflow-y-auto p-2">
        {segments.map((s) => {
          const mk = byIdx.get(s.idx);
          const hidden = needle && !s.text.toLowerCase().includes(needle) && !s.speaker.toLowerCase().includes(needle);
          if (hidden) return null;
          const off = !!s.flags?.length;
          return (
            <div
              id={`seg-${s.idx}`}
              key={s.idx}
              onClick={() => jump(s.idx)}
              className={cn(
                "group cursor-pointer rounded-md border-l-2 px-2.5 py-1.5 text-[13px] leading-relaxed transition-colors hover:bg-secondary/70",
                off && "opacity-45",
                mk && "bg-accent/55",
                (active === s.idx || playing === s.idx) && "bg-primary/15 ring-1 ring-primary/40",
              )}
              style={{ borderLeftColor: ROLE_COLOR[s.role] }}
            >
              <div className="mb-0.5 flex flex-wrap items-center gap-2 font-mono text-[10.5px] text-muted-foreground">
                <span className="font-medium text-foreground/80">{s.speaker}</span>
                <span>{s.role}</span>
                <span>#{s.idx}</span>
                <span>{mmss(s.start)}</span>
                {s.flags?.map((f) => (
                  <span key={f} className="rounded bg-muted px-1">{f}</span>
                ))}
                {mk?.map((m, i) => (
                  <span key={i} className="rounded px-1 text-[10px]" style={{ background: `color-mix(in oklch, ${TONE_COLOR[m.tone]} 18%, transparent)`, color: TONE_COLOR[m.tone] }}>
                    {m.label}
                  </span>
                ))}
              </div>
              {s.flags?.includes("ruido") ? <span className="italic text-muted-foreground">(trecho de ruído da transcrição)</span> : s.text}
            </div>
          );
        })}
      </div>
    </div>
  );
}
