"use client";

import { Coins, Columns3, Lightbulb, Phone, Users, UsersRound } from "lucide-react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/calls", label: "Calls", icon: Phone },
  { href: "/time", label: "Time", icon: UsersRound },
  { href: "/closers", label: "Closers", icon: Users },
  { href: "/comparar", label: "Comparar", icon: Columns3 },
  { href: "/insights", label: "Insights", icon: Lightbulb },
  { href: "/custos", label: "Custos", icon: Coins },
];

export function NavLinks() {
  const path = usePathname();
  const params = useSearchParams();
  const pb = params.get("playbook");
  return (
    <nav className="flex items-center gap-1.5 overflow-x-auto">
      {LINKS.map((l) => {
        const active = path === l.href || path.startsWith(`${l.href}/`);
        const Icon = l.icon;
        return (
          <Link
            key={l.href}
            href={pb ? `${l.href}?playbook=${pb}` : l.href}
            className={cn("pill border-transparent px-3 py-1.5", active && "pill-active")}
            aria-current={active ? "page" : undefined}
          >
            <Icon className={cn("size-3.5", active ? "text-primary" : "opacity-70")} />
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}

