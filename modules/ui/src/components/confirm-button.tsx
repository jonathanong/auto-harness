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
  /** Returning a failure keeps the dialog open and displays the message for retry. */
  onConfirm: () => Promise<void | { ok: false; error: string }>;
  pw?: string;
  variant?: ButtonProps["variant"];
  size?: ButtonProps["size"];
  disabled?: boolean;
};

function errorPw(pw: string | undefined) {
  return pw ? pw + "-error" : "confirm-error";
}

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
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    setError(null);
  };

  const trigger = (
    <Button type="button" variant={variant} size={size} disabled={disabled} data-pw={pw}>
      {triggerLabel}
    </Button>
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) close();
        else setOpen(true);
      }}
    >
      <DialogTrigger asChild>
        {tip ? <WithTooltip tip={tip}>{trigger}</WithTooltip> : trigger}
      </DialogTrigger>
      <DialogContent data-pw={pw ? `${pw}-confirm` : "confirm-dialog"}>
        <DialogHeader>
          <DialogTitle>{confirmTitle}</DialogTitle>
          {confirmDescription ? <DialogDescription>{confirmDescription}</DialogDescription> : null}
        </DialogHeader>
        {error ? (
          <p className="text-sm text-red-700" data-pw={errorPw(pw)}>
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={close}>
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
                setError(null);
                try {
                  const result = await onConfirm();
                  if (result && !result.ok) {
                    setError(result.error);
                    return;
                  }
                  setOpen(false);
                } catch (cause) {
                  setError(
                    cause instanceof Error && cause.message ? cause.message : "request failed",
                  );
                }
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
