import { Bell } from "lucide-react";
import Link from "next/link";
import { unreadNotifications } from "@/core/queries";
import { getContext } from "@/lib/server/context";

export async function NotificationBell() {
  const { db, viewer } = await getContext();
  const n = await unreadNotifications(db, viewer);
  return (
    <Link href="/notificacoes" className="relative grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground" aria-label={`Notificações${n ? ` (${n} não lidas)` : ""}`}>
      <Bell className="size-4" />
      {n > 0 && (
        <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-crit px-1 font-mono text-[9.5px] font-medium leading-none text-white">
          {n > 99 ? "99+" : n}
        </span>
      )}
    </Link>
  );
}
