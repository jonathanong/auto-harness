"use client";

import { useState, useTransition } from "react";

import { Button, type ButtonProps } from "./button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.tsx";
import { WithTooltip } from "./tooltip.tsx";

export type ConfirmButtonProps = {
  triggerLabel: string;
  confirmTitle: string;
  confirmDescription?: string;
  confirmLabel?: string;
  tip?: string;
  onConfirm: () => Promise<void>;
  pw?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
};

/** A destructive-action button that requires an explicit confirm step in a modal. */
export function ConfirmButton({
  triggerLabel,
  confirmTitle,
  confirmDescription,
  confirmLabel = "Remove",
  tip,
  onConfirm,
  pw,
  variant = "outline",
  size = "sm",
  disabled,
}: ConfirmButtonProps) {
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();

  const trigger = (
    <Button type="button" variant={variant} size={size} disabled={disabled} data-pw={pw}>
      {triggerLabel}
    </Button>
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {tip ? <WithTooltip tip={tip}>{trigger}</WithTooltip> : trigger}
      </DialogTrigger>
      <DialogContent data-pw={pw ? `${pw}-confirm` : "confirm-dialog"}>
        <DialogHeader>
          <DialogTitle>{confirmTitle}</DialogTitle>
          {confirmDescription ? <DialogDescription>{confirmDescription}</DialogDescription> : null}
        </DialogHeader>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={pending}
            data-pw={pw ? `${pw}-confirm-submit` : undefined}
            onClick={() => {
              start(async () => {
                await onConfirm();
                setOpen(false);
              });
            }}
          >
            {pending ? "Removing…" : confirmLabel}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
