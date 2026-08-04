"use client";

import * as React from "react";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";

import { cn } from "../lib/utils.ts";

/** Root provider — place once near the app root (control-shell / host-shell). */
export function TooltipProvider({
  delayDuration = 300,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} {...props}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export const TooltipContent = React.forwardRef<
  React.ElementRef<typeof TooltipPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>
>(({ className, sideOffset = 4, ...props }, ref) => (
  <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        "z-50 max-w-xs overflow-hidden rounded-md border border-border bg-primary px-3 py-1.5 text-xs text-primary-foreground shadow-md animate-in fade-in-0 zoom-in-95",
        "data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
        "data-[side=bottom]:slide-in-from-top-1 data-[side=left]:slide-in-from-right-1 data-[side=right]:slide-in-from-left-1 data-[side=top]:slide-in-from-bottom-1",
        className,
      )}
      {...props}
    />
  </TooltipPrimitive.Portal>
));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

export type WithTooltipProps = {
  /** Tooltip body (plain text preferred for a11y). */
  tip: string;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  /** When true, wrap children so disabled buttons still show tooltips. */
  asChild?: boolean;
};

/**
 * Wrap any control with a hover/focus tooltip.
 * Disabled interactive children are wrapped in a span so the tip still works.
 */
export function WithTooltip({ tip, children, side = "top", asChild = true }: WithTooltipProps) {
  if (!tip) {
    return children;
  }
  const child = children as React.ReactElement<{ disabled?: boolean }>;
  const disabled = Boolean(child.props?.disabled);
  return (
    <Tooltip>
      {/* asChild always applies here (even when disabled) — Radix's Slot clones its props
          onto whichever single element is passed (the span below, or children directly)
          instead of rendering its own wrapping element. Without it, a disabled Button
          (itself a <button>) ends up nested inside Radix's own <button> trigger — invalid
          HTML that fails hydration. */}
      <TooltipTrigger asChild={asChild}>
        {disabled ? <span className="inline-flex cursor-not-allowed">{children}</span> : children}
      </TooltipTrigger>
      <TooltipContent side={side}>{tip}</TooltipContent>
    </Tooltip>
  );
}
