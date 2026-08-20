"use client";

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition } from "react";
import { Button, Input, Label, Textarea, WithTooltip, withToast } from "@auto-harness/ui";

import { apiBase, apiErrorMessage } from "@auto-harness/shared";

import {
  catalogCommandDefaults,
  catalogProviderKey,
  retainOrSuggestCommandName,
} from "../lib/catalog-command-defaults.ts";

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
  const [commandName, setCommandName] = useState("");
  const [argvText, setArgvText] = useState("");
  const [appendPrompt, setAppendPrompt] = useState(true);
  const [appendPromptSeparator, setAppendPromptSeparator] = useState(true);
  const lastCatalogKey = useRef<string | null>(null);

  function applyNameDefaults(name: string): void {
    const key = catalogProviderKey(name);
    if (key === lastCatalogKey.current) return;
    lastCatalogKey.current = key;
    if (key === null) return;
    const defaults = catalogCommandDefaults(name)!;
    setCommandName(retainOrSuggestCommandName(commandName, defaults.commandName));
    setArgvText(defaults.argv.join("\n"));
    setAppendPrompt(defaults.appendPrompt);
    setAppendPromptSeparator(defaults.appendPromptSeparator);
  }

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-provider-catalog"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        const fd = new FormData(e.currentTarget);
        const name = String(fd.get("name") ?? "").trim();
        const argv = String(fd.get("argv") ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean);
        const submittedCommandName = commandName.trim();
        start(async () => {
          const providerRes = await fetch(`${apiBase()}/api/v1/providers`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ name }),
          });
          if (!providerRes.ok) {
            setError(await apiErrorMessage(providerRes));
            return;
          }
          const provider = (await providerRes.json()) as { id: string };

          const commandRes = await fetch(`${apiBase()}/api/v1/commands`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              name: submittedCommandName,
              argv,
              appendPrompt,
              appendPromptSeparator,
              providerId: provider.id,
            }),
          });
          if (!commandRes.ok) {
            setError(
              `provider "${name}" created, but its default command failed: ${await apiErrorMessage(commandRes)}`,
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
              `provider "${name}" and command "${submittedCommandName}" created, but linking the default failed: ${await apiErrorMessage(linkRes)}`,
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
          Name
        </Label>
        <Input
          id="name"
          name="name"
          required
          data-pw="provider-catalog-name"
          onChange={(event) => applyNameDefaults(event.currentTarget.value)}
        />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="commandName"
          tip="Catalog label for this command — not the binary on disk (the first argv token is the executable)"
        >
          Default Command Name
        </Label>
        <Input
          id="commandName"
          name="commandName"
          required
          placeholder="claude-print"
          data-pw="provider-catalog-command-name"
          value={commandName}
          onChange={(event) => setCommandName(event.currentTarget.value)}
        />
        <p className="text-xs text-muted-foreground">
          Catalog label for this command — not the binary on disk (the first argv token is the
          executable).
        </p>
      </div>
      <div className="space-y-1">
        <Label htmlFor="argv" tip="One argv element per line — never a shell string">
          Default Command Argv (One Per Line)
        </Label>
        <Textarea
          id="argv"
          name="argv"
          required
          rows={3}
          placeholder={"claude\n-p"}
          className="font-mono text-xs"
          data-pw="provider-catalog-argv"
          value={argvText}
          onChange={(event) => setArgvText(event.currentTarget.value)}
        />
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="appendPrompt"
          checked={appendPrompt}
          onChange={(event) => setAppendPrompt(event.currentTarget.checked)}
          data-pw="provider-catalog-append-prompt"
        />
        Append Session Prompt as the Final Argv Element
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          name="appendPromptSeparator"
          checked={appendPromptSeparator}
          onChange={(event) => setAppendPromptSeparator(event.currentTarget.checked)}
          data-pw="provider-catalog-append-prompt-separator"
        />
        Insert -- Before the Prompt (On by Default; Grok&apos;s -p Takes the Prompt as Its Value —
        Leave This Off for Grok)
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
