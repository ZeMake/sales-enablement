"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const ALL = "__todos__";

/** Select que grava a escolha na URL (filtros e seletor de playbook compartilháveis por link). */
export function UrlSelect({
  param,
  options,
  placeholder,
  allLabel,
  fallback,
  className,
}: {
  param: string;
  options: Array<{ value: string; label: string }>;
  placeholder: string;
  allLabel?: string;
  /** Valor efetivo quando o parâmetro não está na URL (ex.: playbook padrão). */
  fallback?: string;
  className?: string;
}) {
  const router = useRouter();
  const path = usePathname();
  const params = useSearchParams();
  const current = params.get(param) ?? fallback ?? (allLabel ? ALL : undefined);
  // Texto explícito: o Select do Radix só conhece os rótulos depois de abrir a lista.
  const label = current === ALL ? allLabel : options.find((o) => o.value === current)?.label;
  return (
    <Select
      value={current}
      onValueChange={(v) => {
        const next = new URLSearchParams(params);
        if (v === ALL) next.delete(param);
        else next.set(param, v);
        router.push(`${path}?${next.toString()}`);
      }}
    >
      <SelectTrigger size="sm" className={className ?? "w-[170px]"}>
        <SelectValue placeholder={placeholder}>{label}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {allLabel && <SelectItem value={ALL}>{allLabel}</SelectItem>}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
