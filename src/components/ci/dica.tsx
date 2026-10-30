"use client";

import { CircleHelp } from "lucide-react";
import type { ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** "?" ao lado de um rótulo: explica, em uma ou duas frases, como ler o número. */
export function Dica({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" aria-label="O que é isso?" className={cn("inline-flex cursor-help align-middle text-muted-foreground/70 transition hover:text-primary", className)}>
          <CircleHelp className="size-3.5" />
        </button>
      </TooltipTrigger>
      <TooltipContent className="block max-w-sm text-left text-[12.5px] leading-relaxed normal-case tracking-normal">{children}</TooltipContent>
    </Tooltip>
  );
}

/** Envolve um elemento já existente (selo, chip) com a explicação ao passar o mouse. */
export function ComDica({ dica, children }: { dica: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="cursor-help">{children}</span>
      </TooltipTrigger>
      <TooltipContent className="block max-w-sm text-left text-[12.5px] leading-relaxed">{dica}</TooltipContent>
    </Tooltip>
  );
}
