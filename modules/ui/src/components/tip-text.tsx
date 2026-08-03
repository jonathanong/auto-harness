"use client";

import type { ReactNode } from "react";

import { WithTooltip } from "./tooltip.tsx";

export type TipTextProps = {
  tip: string;
  className?: string;
  children: ReactNode;
  as?: "span" | "h2" | "h3" | "p" | "div";
  pw?: string;
};

/** Hoverable text with tooltip (for server-rendered pages). */
export function TipText({ tip, className, children, as: Tag = "span", pw }: TipTextProps) {
  return (
    <WithTooltip tip={tip}>
      <Tag className={className} data-pw={pw}>
        {children}
      </Tag>
    </WithTooltip>
  );
}
