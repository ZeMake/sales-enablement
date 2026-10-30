import { CalendarDays, Cpu, DatabaseZap, Phone, Receipt, Users, Wallet } from "lucide-react";
import { SectionTitle } from "@/components/ci/section";
import Link from "next/link";
import { Suspense } from "react";
import { Stat } from "@/components/ci/badges";
import { UrlSelect } from "@/components/ci/url-select";
import { costSummary, type Linha } from "@/core/costs";
import { dataCurta, pct } from "@/lib/format";
import { getContext } from "@/lib/server/context";

export const metadata = { title: "Custos" };

const moeda = (n: number, casas: number) => n.toLocaleString("pt-BR", { minimumFractionDigits: casas, maximumFractionDigits: casas });
/** Vírgula decimal (pt-BR): "US$ 3,98"; abaixo de 1, três casas ("US$ 0,036"). */
const usd = (n: number | null | undefined) => (n == null ? "—" : `US$ ${moeda(n, n < 1 ? 3 : 2)}`);
const brl = (n: number) => `R$ ${moeda(n, 2)}`;
const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("pt-BR"));

export default async function CostsPage(props: PageProps<"/custos">) {
  const sp = await props.searchParams;
  const periodo = (Array.isArray(sp.periodo) ? sp.periodo[0] : sp.periodo) ?? "tudo";
  const de = inicioDoPeriodo(periodo);
  const { db, viewer } = await getContext();
  const c = await costSummary(db, viewer, { de });
  const t = c.total;
  const soAssinatura = t.api_usd === 0 && t.assinatura_usd > 0;

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Custo visível</div>
          <h1 className="display mt-2 text-[2.6rem] md:text-5xl">
            Quanto custa <span className="text-brand">cada call</span>
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
            Cada chamada à IA fica registrada com tokens e custo. Pelo Claude Code (assinatura), o valor é o <b>equivalente</b> em API: não é cobrado à parte, mas consome a cota.
          </p>
        </div>
        <Suspense>
          <UrlSelect param="periodo" placeholder="Período" fallback="tudo" options={[{ value: "tudo", label: "Todo o período" }, { value: "30d", label: "Últimos 30 dias" }, { value: "7d", label: "Últimos 7 dias" }]} className="w-[170px]" />
        </Suspense>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat icon={Wallet} label={soAssinatura ? "Total (equivalente)" : "Total"} value={usd(t.usd)} hint={`${brl(t.brl)} · ${t.chamadas} chamada(s)`} />
        <Stat icon={Receipt} label="API (real) · assinatura (equiv.)" value={<span className="text-3xl">{usd(t.api_usd)} · {usd(t.assinatura_usd)}</span>} hint="só o primeiro é cobrado à parte" />
        <Stat icon={Phone} label="Custo médio por call" value={usd(c.por_call_media.usd)} hint={`${c.por_call_media.calls} call(s) · triagem + análises`} />
        <Stat icon={DatabaseZap} label="Entrada lida do cache" value={pct(t.cache_pct)} hint={`${k(t.tokens.cache_read)} lidos · ${k(t.tokens.cache_write)} escritos · ${k(t.tokens.input)} sem cache`} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <section className="panel p-5">
          <SectionTitle icon={CalendarDays} title="Por dia" />
          <Bars linhas={c.por_dia.map((l) => ({ ...l, label: dataCurta(l.chave) }))} />
        </section>
        <section className="panel p-5">
          <SectionTitle icon={Users} title="Por closer" />
          <Bars linhas={c.por_closer} />
        </section>
      </div>

      <section className="panel overflow-x-auto p-5">
        <SectionTitle icon={Cpu} title="Por etapa e modelo · tokens com e sem cache" className="mb-2" />
        <p className="mb-3 text-xs text-muted-foreground">Sem cache = entrada cobrada inteira. Escrita de cache custa 1,25× a entrada; leitura, 0,1×.</p>
        <TokenTable linhas={[...c.por_etapa, ...c.por_modelo]} split={c.por_etapa.length} />
      </section>

      <section className="panel overflow-x-auto p-5">
        <SectionTitle icon={Phone} title="Por call" />
        <table className="w-full min-w-[640px] text-sm">
          <thead className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
            <tr className="text-left">
              <th className="pb-2">Call</th>
              <th className="pb-2">Closer</th>
              <th className="pb-2 text-right">Chamadas</th>
              <th className="pb-2 text-right">Entrada</th>
              <th className="pb-2 text-right">Saída</th>
              <th className="pb-2 text-right">Custo</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {c.por_call.map((l) => (
              <tr key={l.chave}>
                <td className="py-2">{l.chave.startsWith("(") ? <span className="text-muted-foreground">{l.chave}</span> : <Link href={`/calls/${l.chave}`} className="font-mono text-xs hover:text-primary">{l.chave}</Link>}</td>
                <td>{l.closer ?? "—"}</td>
                <td className="text-right font-mono">{l.chamadas}</td>
                <td className="text-right font-mono">{k(l.tokens.input + l.tokens.cache_read + l.tokens.cache_write)}</td>
                <td className="text-right font-mono">{k(l.tokens.output)}</td>
                <td className="text-right font-mono">{usd(l.usd)}</td>
              </tr>
            ))}
            {!c.por_call.length && (
              <tr>
                <td colSpan={6} className="py-6 text-center text-muted-foreground">Nenhum custo registrado no período.</td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

/** Primeiro dia (AAAA-MM-DD, fuso local) do período "7d" ou "30d"; "tudo" não filtra. */
function inicioDoPeriodo(periodo: string): string | undefined {
  const dias = periodo === "7d" ? 7 : periodo === "30d" ? 30 : null;
  return dias ? new Date(Date.now() - (dias - 1) * 864e5).toLocaleDateString("sv-SE") : undefined;
}

function Bars({ linhas }: { linhas: Linha[] }) {
  if (!linhas.length) return <p className="text-sm text-muted-foreground">Nenhum custo no período.</p>;
  const max = Math.max(...linhas.map((l) => l.usd)) || 1;
  return (
    <div className="space-y-2">
      {linhas.map((l) => (
        <div key={l.chave} className="grid grid-cols-[130px_1fr_96px] items-center gap-3 text-sm" title={`${l.label}: ${usd(l.usd)} · ${brl(l.brl)} · ${l.chamadas} chamada(s)`}>
          <span className="truncate">{l.label}</span>
          <div className="h-4 overflow-hidden rounded-r-[4px] bg-muted">
            <div className="h-full rounded-r-[4px] bg-primary" style={{ width: `${(l.usd / max) * 100}%` }} />
          </div>
          <span className="text-right font-mono text-xs">{usd(l.usd)}</span>
        </div>
      ))}
    </div>
  );
}

function TokenTable({ linhas, split }: { linhas: Linha[]; split: number }) {
  return (
    <table className="w-full min-w-[720px] text-sm">
      <thead className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">
        <tr className="text-left">
          <th className="pb-2" />
          <th className="pb-2 text-right">Chamadas</th>
          <th className="pb-2 text-right">Sem cache</th>
          <th className="pb-2 text-right">Cache escrito</th>
          <th className="pb-2 text-right">Cache lido</th>
          <th className="pb-2 text-right">Saída</th>
          <th className="pb-2 text-right">Custo</th>
          <th className="pb-2 text-right">Por chamada</th>
        </tr>
      </thead>
      <tbody>
        {linhas.map((l, i) => (
          <tr key={`${i}-${l.chave}`} className={i === split ? "border-t-2" : "border-t"}>
            <td className="py-2 font-mono text-xs">{l.label}</td>
            <td className="text-right font-mono">{l.chamadas}</td>
            <td className="text-right font-mono">{k(l.tokens.input)}</td>
            <td className="text-right font-mono">{k(l.tokens.cache_write)}</td>
            <td className="text-right font-mono">{k(l.tokens.cache_read)}</td>
            <td className="text-right font-mono">{k(l.tokens.output)}</td>
            <td className="text-right font-mono">{usd(l.usd)}</td>
            <td className="text-right font-mono">{usd(l.usd / l.chamadas)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
