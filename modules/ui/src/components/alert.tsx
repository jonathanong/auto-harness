import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../lib/utils.ts";

const alertVariants = cva("rounded-md border p-3 text-sm", {
  variants: {
    variant: {
      success: "border-success/30 bg-success/10 text-success",
      warning: "border-warning/30 bg-warning/10 text-warning",
      danger: "border-danger/30 bg-danger/10 text-danger",
      info: "border-info/30 bg-info/10 text-info",
    },
  },
  defaultVariants: { variant: "info" },
});

export type AlertProps = React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof alertVariants>;

/**
 * A colored-box primitive only — border, background, and text color. Layout (a flex row with an
 * inline retry button vs. a vertical stack with a heading) stays with each call site, the way
 * `Card`/`CardContent` compose, since it genuinely varies across call sites and a single slot API
 * would fit worse than composing `className`/children directly.
 */
export function Alert({ className, variant, ...props }: AlertProps) {
  return <div className={cn(alertVariants({ variant }), className)} {...props} />;
}
