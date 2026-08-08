"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Input, Label, Textarea, WithTooltip, withToast } from "@auto-harness/ui";
import type { Provider } from "@auto-harness/shared";

import { apiBase } from "../lib/api.ts";

async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return body?.error?.message ?? `request failed (${res.status})`;
}

export function CommandCreateForm({
  providers,
  fixedProviderId,
}: {
  /** Full provider list for the "(none — standalone)" picker. Omit when fixedProviderId is set. */
  providers?: Provider[];
  /** Pins this command to a provider (rendered as a fixed field, not a picker) and, on success,
   * refreshes in place instead of navigating away — used from a provider's own Commands tab,
   * where the association should not be editable away and the operator stays to set it as
   * default next. */
  fixedProviderId?: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-command-catalog"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const name = String(fd.get("name") ?? "").trim();
        const argv = String(fd.get("argv") ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const appendPrompt = fd.get("appendPrompt") === "on";
        const providerId = fixedProviderId ?? (String(fd.get("providerId") ?? "") || null);
        start(async () => {
          const res = await fetch(`${apiBase()}/api/v1/commands`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, argv, appendPrompt, providerId }),
          });
          if (!res.ok) {
            setError(await errorMessage(res));
            return;
          }
          if (fixedProviderId) {
            form.reset();
            router.refresh();
            return;
          }
          const created = (await res.json()) as { id: string };
          router.push(withToast(`/commands/${created.id}`, "Command created."));
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="name" tip="Display name for this command">
          name
        </Label>
        <Input
          id="name"
          name="name"
          required
          placeholder="claude-print"
          data-pw="command-catalog-name"
        />
      </div>
      <div className="space-y-1">
        <Label htmlFor="argv" tip="One argv element per line — never a shell string">
          argv (one per line)
        </Label>
        <Textarea
          id="argv"
          name="argv"
          required
          rows={4}
          className="font-mono text-xs"
          data-pw="command-catalog-argv"
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="appendPrompt"
          defaultChecked
          data-pw="command-catalog-append-prompt"
        />
        append session prompt as the final argv element
      </label>
      {fixedProviderId || !providers ? null : (
        <div className="space-y-1">
          <Label
            htmlFor="providerId"
            tip="Standalone commands (none) run ungated on any worktree; provider-owned commands are reached through that provider's accounts"
          >
            provider
          </Label>
          <select
            id="providerId"
            name="providerId"
            defaultValue=""
            className="flex h-9 rounded-md border border-border bg-background px-3 text-sm"
            data-pw="command-catalog-provider"
          >
            <option value="">(none — standalone)</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {error ? (
        <p className="text-sm text-red-700" data-pw="command-catalog-error">
          {error}
        </p>
      ) : null}
      <WithTooltip tip="Register a command in the control-plane catalog">
        <Button type="submit" disabled={pending} data-pw="command-catalog-submit">
          {pending ? "Saving…" : "Create command"}
        </Button>
      </WithTooltip>
    </form>
  );
}
