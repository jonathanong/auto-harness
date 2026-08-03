"use client";

import type { ReactNode } from "react";
import Link from "next/link";

import { WithTooltip } from "./tooltip.tsx";

export type TipLinkProps = {
  href: string;
  tip: string;
  className?: string;
  children: ReactNode;
  pw?: string;
};

/** Client Link with a tooltip (for use from server components). */
export function TipLink({ href, tip, className, children, pw }: TipLinkProps) {
  return (
    <WithTooltip tip={tip}>
      <Link href={href} className={className} data-pw={pw}>
        {children}
      </Link>
    </WithTooltip>
  );
}
