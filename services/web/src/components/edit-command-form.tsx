"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  Input,
  Label,
  Textarea,
  WithTooltip,
} from "@auto-harness/ui";
import type { Command, Provider } from "@auto-harness/shared";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

export function EditCommandForm({
  command,
  providers,
}: {
  command: Command;
  providers: Provider[];
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="outline" data-pw="edit-command-open">
          Edit command
        </Button>
      </DialogTrigger>
      <DialogContent data-pw="edit-command-dialog">
        <DialogHeader>
          <DialogTitle>Edit command</DialogTitle>
          <DialogDescription>
            Update this command's name, argv, prompt handling, and provider.
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-2"
          data-pw="form-edit-command"
          onSubmit={(e) => {
            e.preventDefault();
            setError(null);
            const fd = new FormData(e.currentTarget);
            const name = String(fd.get("name") ?? "").trim();
            const argv = String(fd.get("argv") ?? "")
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean);
            const appendPrompt = fd.get("appendPrompt") === "on";
            const appendPromptSeparator = fd.get("appendPromptSeparator") === "on";
            const providerId = String(fd.get("providerId") ?? "") || null;
            start(async () => {
              const res = await fetch(
                `${apiBase()}/api/v1/commands/${encodeURIComponent(command.id)}`,
                {
                  method: "PUT",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({
                    name,
                    argv,
                    appendPrompt,
                    appendPromptSeparator,
                    providerId,
                  }),
                },
              );
              if (!res.ok) {
                setError(await apiErrorMessage(res));
                return;
              }
              setOpen(false);
              router.refresh();
            });
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="name" tip="Display name for this command">
              Name
            </Label>
            <Input
              id="name"
              name="name"
              defaultValue={command.name}
              required
              data-pw="edit-command-name"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="argv" tip="One argv element per line — never a shell string">
              Argv (One Per Line)
            </Label>
            <Textarea
              id="argv"
              name="argv"
              required
              rows={4}
              defaultValue={command.argv.join("\n")}
              className="font-mono text-xs"
              data-pw="edit-command-argv"
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="appendPrompt"
              defaultChecked={command.appendPrompt}
              data-pw="edit-command-append-prompt"
            />
            Append Session Prompt as the Final Argv Element
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              name="appendPromptSeparator"
              defaultChecked={command.appendPromptSeparator}
              data-pw="edit-command-append-prompt-separator"
            />
            Insert -- Before the Prompt (Getopt-Style CLIs Only — Breaks Commands like Printf)
          </label>
          <div className="space-y-1">
            <Label
              htmlFor="providerId"
              tip="Standalone commands (none) run ungated on any worktree; provider-owned commands are reached through that provider's accounts"
            >
              Provider
            </Label>
            <select
              id="providerId"
              name="providerId"
              defaultValue={command.providerId ?? ""}
              className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
              data-pw="edit-command-provider"
            >
              <option value="">(none — standalone)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {error ? (
            <p className="text-sm text-red-700" data-pw="edit-command-error">
              {error}
            </p>
          ) : null}
          <div className="flex gap-2">
            <WithTooltip tip="Save changes to this command">
              <Button type="submit" size="sm" disabled={pending} data-pw="edit-command-submit">
                {pending ? "Saving…" : "Save"}
              </Button>
            </WithTooltip>
            <Button type="button" size="sm" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
