/* eslint-disable max-lines -- the structured singleton form keeps all bindings in one operator view. */
"use client";

import { useEffect, useState, useTransition } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  Textarea,
  showToast,
} from "@auto-harness/ui";

import { apiFetch } from "../lib/client-api.ts";

type Binding = {
  githubRepositoryId: string;
  repositoryId: string;
  targetType: "providerId" | "commandId";
  targetId: string;
  timeout: string;
  queueTtlSeconds: string;
  priority: string;
  requiredLabels: string;
  fallbacks: string;
  defaultRef: string;
  allowedLogins: string;
  enabled: boolean;
};
const blank = (): Binding => ({
  githubRepositoryId: "",
  repositoryId: "",
  targetType: "providerId",
  targetId: "",
  timeout: "3600",
  queueTtlSeconds: "691200",
  priority: "0",
  requiredLabels: "",
  fallbacks: "",
  defaultRef: "refs/heads/main",
  allowedLogins: "",
  enabled: true,
});

function parseFallbackTargets(
  value: string,
): { ok: true; targets: Array<{ providerId: string } | { commandId: string }> } | { ok: false } {
  const targets: Array<{ providerId: string } | { commandId: string }> = [];
  for (const entry of value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const kind = separator < 0 ? "" : entry.slice(0, separator).trim();
    const id = separator < 0 ? "" : entry.slice(separator + 1).trim();
    if (!id || (kind !== "provider" && kind !== "command")) return { ok: false };
    targets.push(kind === "provider" ? { providerId: id } : { commandId: id });
  }
  return { ok: true, targets };
}

/** Structured singleton editor; webhook secret stays empty on load and is retained on PUT. */
export function GitHubIngressSettings() {
  const [pending, start] = useTransition();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "forbidden" | "error">(
    "loading",
  );
  const [configured, setConfigured] = useState(false);
  const [secret, setSecret] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [version, setVersion] = useState<number>();
  const [generation, setGeneration] = useState<string | null>();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [bindings, setBindings] = useState<Binding[]>([blank()]);
  useEffect(() => {
    void apiFetch("/api/v1/integrations/github-ingress", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 404) {
          setLoadState("ready");
          return;
        }
        if (response.status === 401 || response.status === 403) {
          setLoadState("forbidden");
          return;
        }
        if (!response.ok) {
          setLoadState("error");
          return;
        }
        const value = (await response.json()) as {
          enabled: boolean;
          version: number;
          generation?: string;
          bindings: Array<{
            githubRepositoryId: number;
            repositoryId: string;
            target: Record<string, string>;
            timeout: number;
            queueTtlSeconds: number;
            priority: number;
            requiredLabels: string[];
            fallbacks: Array<Record<string, string>>;
            defaultRef: string;
            allowedLogins: string[];
          }>;
        };
        setConfigured(true);
        setVersion(value.version);
        setGeneration(value.generation ?? null);
        setLoadState("ready");
        setEnabled(value.enabled);
        setBindings(
          value.bindings.map((binding) => ({
            githubRepositoryId: String(binding.githubRepositoryId),
            repositoryId: binding.repositoryId,
            targetType: "providerId" in binding.target ? "providerId" : "commandId",
            targetId: binding.target.providerId ?? binding.target.commandId ?? "",
            timeout: String(binding.timeout),
            queueTtlSeconds: String(binding.queueTtlSeconds),
            priority: String(binding.priority),
            requiredLabels: binding.requiredLabels.join("\n"),
            fallbacks: binding.fallbacks
              .map((fallback) =>
                "providerId" in fallback
                  ? `provider:${fallback.providerId}`
                  : `command:${fallback.commandId}`,
              )
              .join(", "),
            defaultRef: binding.defaultRef,
            allowedLogins: binding.allowedLogins.join(", "),
            enabled: true,
          })),
        );
      })
      .catch(() => setLoadState("error"));
  }, []);
  const change = (index: number, field: keyof Binding, value: string | boolean) =>
    setBindings((current) =>
      current.map((binding, position) =>
        position === index ? { ...binding, [field]: value } : binding,
      ),
    );
  const save = () =>
    start(async () => {
      if (
        (!configured && !secret) ||
        bindings.some(
          (binding) =>
            !binding.githubRepositoryId ||
            !binding.repositoryId ||
            !binding.targetId ||
            !binding.defaultRef,
        )
      ) {
        showToast("Secret and every binding's repository, target, and default ref are required.", {
          variant: "destructive",
          pw: "github-ingress-error",
        });
        return;
      }
      const parsedFallbacks = bindings.map((binding) => parseFallbackTargets(binding.fallbacks));
      if (parsedFallbacks.some((result) => !result.ok)) {
        showToast("Fallbacks must use provider:id or command:id.", {
          variant: "destructive",
          pw: "github-ingress-error",
        });
        return;
      }
      const body = {
        ...(secret ? { secret } : {}),
        ...(configured ? { version, generation: generation ?? "legacy" } : {}),
        enabled,
        bindings: bindings.map((binding, index) => ({
          githubRepositoryId: Number(binding.githubRepositoryId),
          repositoryId: binding.repositoryId,
          target: { [binding.targetType]: binding.targetId },
          timeout: Number(binding.timeout),
          queueTtlSeconds: Number(binding.queueTtlSeconds),
          priority: Number(binding.priority),
          requiredLabels: binding.requiredLabels
            .split(/\r?\n/)
            .map((label) => label.trim())
            .filter(Boolean),
          fallbacks: parsedFallbacks[index]!.ok ? parsedFallbacks[index].targets : [],
          defaultRef: binding.defaultRef,
          allowedLogins: binding.allowedLogins
            .split(",")
            .map((login) => login.trim())
            .filter(Boolean),
        })),
      };
      try {
        const response = await apiFetch("/api/v1/integrations/github-ingress", {
          method: configured ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error("save failed");
        const saved = (await response.json()) as { version?: number; generation?: string };
        setVersion(saved.version);
        setGeneration(saved.generation ?? null);
        setConfigured(true);
        setSecret("");
        showToast("GitHub ingress configuration saved.", { pw: "github-ingress-success" });
      } catch {
        showToast("Unable to save GitHub ingress configuration.", {
          variant: "destructive",
          pw: "github-ingress-error",
        });
      }
    });
  const remove = () =>
    start(async () => {
      try {
        const response = await apiFetch("/api/v1/integrations/github-ingress", {
          method: "DELETE",
          headers: {
            "if-match": String(version),
            "if-match-generation": generation ?? "legacy",
          },
        });
        if (!response.ok) throw new Error("delete failed");
      } catch {
        showToast("Unable to delete GitHub ingress configuration.", {
          variant: "destructive",
          pw: "github-ingress-error",
        });
        return;
      }
      setConfigured(false);
      setVersion(undefined);
      setGeneration(undefined);
      setConfirmingDelete(false);
      setSecret("");
      setBindings([blank()]);
      showToast("GitHub ingress configuration deleted.", { pw: "github-ingress-success" });
    });
  if (loadState === "loading") {
    return <div aria-busy="true" />;
  }
  if (loadState === "forbidden") {
    return (
      <div>
        <h3 className="text-lg font-medium">GitHub App ingress</h3>
        <p className="text-sm text-red-700" role="alert">
          You do not have permission to manage GitHub App ingress settings.
        </p>
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div>
        <h3 className="text-lg font-medium">GitHub App ingress</h3>
        <p className="text-sm text-red-700" role="alert">
          Unable to load GitHub ingress configuration. Try again later.
        </p>
      </div>
    );
  }
  return (
    <Card data-pw="github-ingress-settings-card">
      <CardHeader>
        <CardTitle>GitHub App ingress</CardTitle>
        <p className="text-sm text-muted-foreground">
          Configure the separate ingress App webhook secret and each GitHub repository’s fixed
          routing.
        </p>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="space-y-1">
          <Label htmlFor="github-ingress-secret">
            Webhook secret {configured ? "(leave blank to retain)" : ""}
          </Label>
          <Input
            id="github-ingress-secret"
            type="password"
            value={secret}
            onChange={(event) => setSecret(event.target.value)}
            data-pw="github-ingress-secret"
          />
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(event) => setEnabled(event.target.checked)}
            data-pw="github-ingress-enabled"
          />{" "}
          Enabled
        </label>
        {bindings.map((binding, index) => (
          <fieldset className="grid gap-2 rounded-md border p-3" key={index}>
            <legend className="px-1 text-sm font-medium">Repository binding {index + 1}</legend>
            <Input
              aria-label="GitHub repository id"
              value={binding.githubRepositoryId}
              onChange={(event) => change(index, "githubRepositoryId", event.target.value)}
              placeholder="GitHub numeric repository id"
            />
            <Input
              aria-label="Auto Harness repository id"
              value={binding.repositoryId}
              onChange={(event) => change(index, "repositoryId", event.target.value)}
              placeholder="Auto Harness repository id"
            />
            <select
              aria-label="Target type"
              value={binding.targetType}
              onChange={(event) => change(index, "targetType", event.target.value)}
            >
              <option value="providerId">Provider</option>
              <option value="commandId">Command</option>
            </select>
            <Input
              aria-label="Target id"
              value={binding.targetId}
              onChange={(event) => change(index, "targetId", event.target.value)}
              placeholder="Target id"
            />
            <Input
              aria-label="Timeout seconds"
              type="number"
              value={binding.timeout}
              onChange={(event) => change(index, "timeout", event.target.value)}
            />
            <Input
              aria-label="Queue TTL seconds"
              type="number"
              value={binding.queueTtlSeconds}
              onChange={(event) => change(index, "queueTtlSeconds", event.target.value)}
              placeholder="Queue TTL seconds"
            />
            <Input
              aria-label="Priority"
              type="number"
              value={binding.priority}
              onChange={(event) => change(index, "priority", event.target.value)}
              placeholder="Priority"
            />
            <Input
              aria-label="Default ref"
              value={binding.defaultRef}
              onChange={(event) => change(index, "defaultRef", event.target.value)}
            />
            <Textarea
              aria-label="Required labels"
              value={binding.requiredLabels}
              onChange={(event) => change(index, "requiredLabels", event.target.value)}
              placeholder="Required labels, one per line"
            />
            <Input
              aria-label="Fallback targets"
              value={binding.fallbacks}
              onChange={(event) => change(index, "fallbacks", event.target.value)}
              placeholder="Fallbacks: provider:id, command:id"
            />
            <Input
              aria-label="Allowed GitHub logins"
              value={binding.allowedLogins}
              onChange={(event) => change(index, "allowedLogins", event.target.value)}
              placeholder="Allowed logins, comma-separated"
            />
            {bindings.length > 1 && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setBindings((current) => current.filter((_, position) => position !== index))
                }
              >
                Remove binding
              </Button>
            )}
          </fieldset>
        ))}
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => setBindings((current) => [...current, blank()])}
            data-pw="github-ingress-add-binding"
          >
            Add binding
          </Button>
          <Button type="button" onClick={save} disabled={pending} data-pw="github-ingress-save">
            Save
          </Button>
          {configured && !confirmingDelete && (
            <Button
              type="button"
              variant="destructive"
              onClick={() => setConfirmingDelete(true)}
              disabled={pending}
              data-pw="github-ingress-delete"
            >
              Delete
            </Button>
          )}
        </div>
        {confirmingDelete && (
          <div
            className="grid gap-2 rounded-md border border-dashed border-border p-3"
            data-pw="github-ingress-delete-confirm"
          >
            <p className="text-sm text-red-700">
              Delete every GitHub ingress binding and the retained webhook secret?
            </p>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="destructive"
                onClick={remove}
                disabled={pending}
                data-pw="github-ingress-delete-confirm-submit"
              >
                {pending ? "Deleting…" : "Confirm delete"}
              </Button>
              <Button type="button" variant="outline" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
