"use client";

import Link from "next/link";
import { WithTooltip } from "@auto-harness/ui";

/** Client Link with shadcn tooltip (for use from server components). */
export function TipLink({
  href,
  tip,
  className,
  children,
  pw,
}: {
  href: string;
  tip: string;
  className?: string;
  children: React.ReactNode;
  pw?: string;
}) {
  return (
    <WithTooltip tip={tip}>
      <Link href={href} className={className} data-pw={pw}>
        {children}
      </Link>
    </WithTooltip>
  );
}
