"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea, WithTooltip, withToast } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `request failed (${res.status})`;
}

/**
 * Creates a Provider and its default Command in one submit. A Provider with no default
 * command resolves to null for every account under it at assign time — so this dialog
 * never leaves a Provider in that state, unlike a two-step "add provider, add command
 * later" flow would.
 */
export function ProviderCreateForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-provider-catalog"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const name = String(fd.get("name") ?? "").trim();
        const commandName = String(fd.get("commandName") ?? "").trim();
        const argv = String(fd.get("argv") ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const appendPrompt = fd.get("appendPrompt") === "on";
        start(async () => {
          const providerRes = await fetch(`${apiBase()}/api/v1/providers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!providerRes.ok) {
            setError(await errorMessage(providerRes));
            return;
          }
          const provider = (await providerRes.json()) as { id: string };

          const commandRes = await fetch(`${apiBase()}/api/v1/commands`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: commandName,
              argv,
              appendPrompt,
              providerId: provider.id,
            }),
          });
          if (!commandRes.ok) {
            setError(
              `provider "${name}" created, but its default command failed: ${await errorMessage(commandRes)}`,
            );
            return;
          }
          const command = (await commandRes.json()) as { id: string };

          const linkRes = await fetch(
            `${apiBase()}/api/v1/providers/${encodeURIComponent(provider.id)}`,
            {
              method: "PATCH",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ defaultCommandId: command.id }),
            },
          );
          if (!linkRes.ok) {
            setError(
              `provider "${name}" and command "${commandName}" created, but linking the default failed: ${await errorMessage(linkRes)}`,
            );
            return;
          }
          router.push(withToast(`/providers/${provider.id}`, "Provider created."));
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="name"
          tip="Lowercase letters, numbers, and dashes only; unique across the catalog (e.g. claude, codex)"
        >
          name
        </Label>
        <Input id="name" name="name" required data-pw="provider-catalog-name" />
      </div>
      <div className="space-y-1">
        <Label htmlFor="commandName" tip="Name for this provider's default command">
          default command name
        </Label>
        <Input
          id="commandName"
          name="commandName"
          required
          placeholder="claude-print"
          data-pw="provider-catalog-command-name"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="argv" tip="One argv element per line — never a shell string">
          default command argv (one per line)
        </Label>
        <Textarea
          id="argv"
          name="argv"
          required
          rows={3}
          placeholder={"claude\n-p"}
          className="font-mono text-xs"
          data-pw="provider-catalog-argv"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="appendPrompt"
          defaultChecked
          data-pw="provider-catalog-append-prompt"
        />
        append session prompt as the final argv element
      </label>
      {error ? (
        <p className="text-sm text-red-700" data-pw="provider-catalog-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Register a provider and its default command together">
        <Button type="submit" disabled={pending} data-pw="provider-catalog-submit">
          {pending ? "Saving…" : "Create provider"}
        </Button>
      </WithTooltip>
    </form>
  );
}
