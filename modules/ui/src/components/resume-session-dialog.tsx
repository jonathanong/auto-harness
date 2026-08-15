"use client";

import { useEffect, useState } from "react";

import { Button } from "./button.tsx";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./dialog.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";

export type ResumeOverrides = { prompt?: string; timeout?: number; priority?: number };

export function ResumeSessionDialog({
  disabled,
  pending,
  error,
  onSubmit,
}: {
  disabled: boolean;
  pending: boolean;
  error?: string | null;
  onSubmit: (overrides: ResumeOverrides) => void;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [timeout, setTimeoutValue] = useState("");
  const [priority, setPriority] = useState("");

  useEffect(() => {
    if (error) setOpen(true);
  }, [error]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={disabled}
        aria-busy={pending}
        data-pw="session-resume"
        onClick={() => setOpen(true)}
      >
        {pending ? "Resuming…" : "Resume"}
      </Button>
      <DialogContent data-pw="session-resume-dialog">
        <DialogHeader>
          <DialogTitle>Resume session</DialogTitle>
          <DialogDescription>
            Continue on the same host when possible. Every override is optional.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p className="text-sm text-red-700" role="alert" data-pw="session-resume-error">
            {error}
          </p>
        ) : null}
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            onSubmit({
              ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
              ...(timeout ? { timeout: Number(timeout) } : {}),
              ...(priority ? { priority: Number(priority) } : {}),
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="resume-prompt">Continuation prompt</Label>
            <Input
              id="resume-prompt"
              data-pw="session-resume-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="resume-timeout">Timeout (seconds)</Label>
            <Input
              id="resume-timeout"
              data-pw="session-resume-timeout"
              type="number"
              min="1"
              step="any"
              value={timeout}
              onChange={(event) => setTimeoutValue(event.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="resume-priority">Priority (0–100)</Label>
            <Input
              id="resume-priority"
              data-pw="session-resume-priority"
              type="number"
              min="0"
              max="100"
              step="1"
              value={priority}
              onChange={(event) => setPriority(event.target.value)}
            />
          </div>
          <Button
            type="submit"
            disabled={disabled}
            aria-busy={pending}
            data-pw="session-resume-submit"
          >
            {pending ? "Resuming…" : "Resume"}
          </Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
