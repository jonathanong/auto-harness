"use client";

import * as React from "react";

import { cn } from "../lib/utils.ts";
import { WithTooltip } from "./tooltip.tsx";

export type LabelProps = React.LabelHTMLAttributes<HTMLLabelElement> & {
  /** Optional shadcn tooltip explaining the field. */
  tip?: string;
};

export function Label({ className, tip, children, ...props }: LabelProps) {
  const label = (
    <label
      className={cn(
        "text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70",
        tip
          ? "inline-flex cursor-help items-center gap-1 border-b border-dotted border-muted-foreground/50"
          : null,
        className,
      )}
      {...props}
    >
      {children}
    </label>
  );
  if (!tip) {
    return label;
  }
  return <WithTooltip tip={tip}>{label}</WithTooltip>;
}
