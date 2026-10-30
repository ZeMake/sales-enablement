import Link from "next/link";
import { markAllNotificationsRead, setNotificationRead } from "@/app/actions";
import { listNotifications, type NotificationItem } from "@/core/queries";
import { getContext } from "@/lib/server/context";
import { cn } from "@/lib/utils";

export const metadata = { title: "Notificações" };

const FILTROS = [
  { id: "", label: "Todas" },
  { id: "alerta_critica", label: "Alertas" },
  { id: "relatorio_diario", label: "Relatórios diários" },
  { id: "nao_lidas", label: "Não lidas" },
];

export default async function NotificationsPage(props: PageProps<"/notificacoes">) {
  const sp = await props.searchParams;
  const filtro = (Array.isArray(sp.f) ? sp.f[0] : sp.f) ?? "";
  const { db, viewer } = await getContext();
  const items = await listNotifications(db, viewer, filtro === "nao_lidas" ? { naoLidas: true } : { tipo: filtro || undefined });
  const naoLidas = items.filter((n) => !n.lida).length;
  const dry = process.env.NOTIFY_DRY_RUN !== "false";

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="eyebrow">Central</div>
          <h1 className="display mt-2 text-[2.6rem] md:text-5xl">Central de <span className="text-brand">notificações</span></h1>
          <p className="mt-2 text-sm text-muted-foreground">Alertas de call crítica ou churn vermelho e o relatório diário de cada gestor.</p>
        </div>
        {naoLidas > 0 && (
          <form action={markAllNotificationsRead}>
            <button className="so-escrita pill">Marcar todas como lidas</button>
          </form>
        )}
      </div>

      {dry && (
        <p className="rounded-md border border-dashed px-4 py-3 text-xs text-muted-foreground">
          <span className="font-mono uppercase tracking-wider text-foreground">Dry-run</span> · nada sai para Slack ou WhatsApp. O que
          seria enviado fica em <code className="font-mono">out/notifications/&lt;data&gt;/</code>. Para ligar: <code className="font-mono">NOTIFY_DRY_RUN=false</code> no .env.
        </p>
      )}

      <nav className="flex flex-wrap gap-1">
        {FILTROS.map((f) => (
          <Link
            key={f.id}
            href={f.id ? `/notificacoes?f=${f.id}` : "/notificacoes"}
            className={cn("rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground", filtro === f.id && "bg-secondary text-foreground")}
          >
            {f.label}
          </Link>
        ))}
      </nav>

      <div className="space-y-3">
        {items.map((n) => (
          <Item key={n.id} n={n} />
        ))}
        {!items.length && (
          <p className="panel px-4 py-8 text-center text-sm text-muted-foreground">
            Nada aqui. Alertas saem do <code className="font-mono">pnpm analyze</code>; o relatório, do <code className="font-mono">pnpm report:daily</code>.
          </p>
        )}
      </div>
    </div>
  );
}

function Item({ n }: { n: NotificationItem }) {
  const p = n.payload;
  const alerta = n.tipo === "alerta_critica";
  return (
    <article className={cn("panel overflow-hidden border-l-4", alerta ? "border-l-crit" : "border-l-primary", n.lida && "opacity-70")}>
      <details open={!n.lida} className="group">
        <summary className="flex cursor-pointer list-none items-start gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
          <span className={cn("mt-1.5 size-2 shrink-0 rounded-full", n.lida ? "bg-transparent" : alerta ? "bg-crit" : "bg-primary")} />
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-2">
              <span className="font-mono text-[10.5px] uppercase tracking-wider text-muted-foreground">{alerta ? "Alerta" : "Relatório diário"}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{quando(n.created_at)}</span>
            </div>
            <h2 className="mt-0.5 font-semibold leading-snug">{p.titulo.replace(/^Alerta: /, "")}</h2>
            {p.resumo && <p className="mt-0.5 text-sm text-muted-foreground">{p.resumo}</p>}
          </div>
          <span className="mt-1 font-mono text-xs text-muted-foreground transition-transform group-open:rotate-90">›</span>
        </summary>
        <div className="space-y-3 px-4 pb-4 pl-9 text-sm">
          {p.secoes.filter((s) => s.itens.length).map((s, i) => (
            <div key={i}>
              {s.titulo && <div className="eyebrow mb-1">{s.titulo}</div>}
              <ul className="space-y-1">
                {s.itens.map((it, j) => (
                  <li key={j} className="leading-snug">
                    <Linkify text={it} />
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {p.links.map((l) => (
              <Link key={l.url} href={local(l.url)} className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:opacity-90">
                {l.label}
              </Link>
            ))}
            <form action={setNotificationRead.bind(null, n.id, !n.lida)} className="so-escrita ml-auto">
              <button className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
                {n.lida ? "Marcar como não lida" : "Marcar como lida"}
              </button>
            </form>
          </div>
        </div>
      </details>
    </article>
  );
}

/** Links do próprio painel viram navegação interna (a mensagem guarda a URL absoluta, para Slack/WhatsApp). */
function local(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

function Linkify({ text }: { text: string }) {
  const parts = text.split(/(https?:\/\/\S+)/g);
  return (
    <>
      {parts.map((part, i) =>
        /^https?:\/\//.test(part) ? (
          <Link key={i} href={local(part)} className="font-mono text-xs text-primary hover:underline">
            abrir
          </Link>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function quando(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}
