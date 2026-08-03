"use client";

import { WithTooltip } from "@auto-harness/ui";

/** Hoverable text with tooltip (for server-rendered pages). */
export function TipText({
  tip,
  className,
  children,
  as: Tag = "span",
  pw,
}: {
  tip: string;
  className?: string;
  children: React.ReactNode;
  as?: "span" | "h2" | "p" | "div";
  pw?: string;
}) {
  return (
    <WithTooltip tip={tip}>
      <Tag className={className} data-pw={pw}>
        {children}
      </Tag>
    </WithTooltip>
  );
}
