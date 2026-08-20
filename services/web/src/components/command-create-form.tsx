"use client";

import { useState } from "react";
import {
  Button,
  Input,
  Label,
  Textarea,
  WithTooltip,
  showToast,
  withToast,
} from "@auto-harness/ui";
import type { Provider } from "@auto-harness/shared";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";
import { navigateBrowser } from "../lib/browser-navigation.ts";

export function CommandCreateForm({
  providers,
  fixedProviderId,
  navigate = navigateBrowser,
}: {
  /** Full provider list for the "(none — standalone)" picker. Omit when fixedProviderId is set. */
  providers?: Provider[];
  /** Pins this command to a provider (rendered as a fixed field, not a picker) and, on success,
   * refreshes in place instead of navigating away — used from a provider's own Commands tab,
   * where the association should not be editable away and the operator stays to set it as
   * default next. */
  fixedProviderId?: string;
  navigate?: (href: string) => void;
}) {
  const [pending, setPending] = useState(false);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-command-catalog"
      onSubmit={(e) => {
        e.preventDefault();
        const form = e.currentTarget;
        const fd = new FormData(form);
        const name = String(fd.get("name") ?? "").trim();
        const argv = String(fd.get("argv") ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const appendPrompt = fd.get("appendPrompt") === "on";
        const appendPromptSeparator = fd.get("appendPromptSeparator") === "on";
        const providerId = fixedProviderId ?? (String(fd.get("providerId") ?? "") || null);
        setPending(true);
        void (async () => {
          const res = await fetch(`${apiBase()}/api/v1/commands`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name, argv, appendPrompt, appendPromptSeparator, providerId }),
          });
          if (!res.ok) {
            showToast(await apiErrorMessage(res), {
              variant: "destructive",
              pw: "command-catalog-error",
            });
            setPending(false);
            return;
          }
          if (fixedProviderId) {
            form.reset();
            setPending(false);
            navigate(`${location.pathname}${location.search}`);
            return;
          }
          const created = (await res.json()) as { id: string };
          setPending(false);
          navigate(withToast(`/commands/${created.id}`, "Command created."));
        })();
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
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="appendPromptSeparator"
          defaultChecked
          data-pw="command-catalog-append-prompt-separator"
        />
        insert -- before the prompt (on by default — uncheck for tools like printf that treat -- as
        data)
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
      <WithTooltip tip="Register a command in the control-plane catalog">
        <Button type="submit" disabled={pending} data-pw="command-catalog-submit">
          {pending ? "Saving…" : "Create command"}
        </Button>
      </WithTooltip>
    </form>
  );
}
