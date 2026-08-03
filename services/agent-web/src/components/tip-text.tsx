"use client";

import { WithTooltip } from "@auto-harness/ui";

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
  as?: "span" | "h2" | "h3" | "p" | "div";
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
