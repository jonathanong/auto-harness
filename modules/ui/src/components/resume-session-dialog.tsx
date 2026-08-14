"use client";

import { useState } from "react";

import { Button } from "./button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "./dialog.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";

export type ResumeOverrides = { prompt?: string; timeout?: number; priority?: number };

export function ResumeSessionDialog({
  disabled,
  pending,
  onSubmit,
}: {
  disabled: boolean;
  pending: boolean;
  onSubmit: (overrides: ResumeOverrides) => void;
}) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [timeout, setTimeoutValue] = useState("");
  const [priority, setPriority] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          aria-busy={pending}
          data-pw="session-resume"
        >
          {pending ? "Resuming…" : "Resume"}
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="session-resume-dialog">
        <DialogHeader>
          <DialogTitle>Resume session</DialogTitle>
          <DialogDescription>
            Continue on the same host when possible. Every override is optional.
          </DialogDescription>
        </DialogHeader>
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
