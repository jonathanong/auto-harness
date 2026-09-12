/* eslint-disable max-lines -- the structured operator form keeps all webhook routing controls together. */
"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmButton,
  Input,
  Label,
  showToast,
} from "@auto-harness/ui";
import { apiFetch } from "../lib/client-api.ts";

type Target = { providerId?: string; commandId?: string };
type Config = {
  id: string;
  repositoryId: string;
  target: Target;
  fallbacks: Target[];
  timeout: number;
  queueTtlSeconds: number;
  priority: number;
  requiredLabels: string[];
  enabled: boolean;
  version?: number;
  generation?: string;
};

const emptyConfig: Config = {
  id: "",
  repositoryId: "",
  target: { providerId: "" },
  fallbacks: [],
  timeout: 3600,
  queueTtlSeconds: 691200,
  priority: 0,
  requiredLabels: [],
  enabled: true,
};

function targetType(target: Target): "providerId" | "commandId" {
  return "commandId" in target ? "commandId" : "providerId";
}

export function CustomWebhookSettings() {
  const [pending, start] = useTransition();
  const [config, setConfig] = useState<Config>(emptyConfig);
  const [secret, setSecret] = useState("");
  const [configured, setConfigured] = useState(false);
  const latestId = useRef(config.id);
  const endpoint = config.id
    ? `/api/v1/integrations/custom/${encodeURIComponent(config.id)}`
    : undefined;

  const load = () => {
    if (!endpoint) {
      showToast("Enter an integration id first.", {
        variant: "destructive",
        pw: "custom-webhook-error",
      });
      return;
    }
    const requestedId = config.id;
    const requestedEndpoint = endpoint;
    start(async () => {
      try {
        const response = await apiFetch(requestedEndpoint, { cache: "no-store" });
        if (latestId.current !== requestedId) return;
        if (response.status === 404) {
          setConfigured(false);
          setConfig((current) => ({ ...current, version: undefined }));
          showToast("No configuration exists for this id yet.", { pw: "custom-webhook-error" });
          return;
        }
        if (!response.ok) {
          showToast("Unable to load custom webhook configuration.", {
            variant: "destructive",
            pw: "custom-webhook-error",
          });
          return;
        }
        const loaded = (await response.json()) as Config;
        if (latestId.current !== requestedId || loaded.id !== requestedId) return;
        setConfig({
          id: loaded.id,
          repositoryId: loaded.repositoryId,
          target: loaded.target,
          fallbacks: loaded.fallbacks ?? [],
          timeout: loaded.timeout,
          queueTtlSeconds: loaded.queueTtlSeconds,
          priority: loaded.priority,
          requiredLabels: loaded.requiredLabels ?? [],
          enabled: loaded.enabled,
          version: loaded.version,
          generation: loaded.generation,
        });
        setSecret("");
        setConfigured(true);
        showToast("Custom webhook configuration loaded.", { pw: "custom-webhook-loaded" });
      } catch {
        showToast("Unable to load custom webhook configuration.", {
          variant: "destructive",
          pw: "custom-webhook-error",
        });
      }
    });
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (
      !config.id ||
      !config.repositoryId ||
      (!config.target.providerId && !config.target.commandId) ||
      !config.timeout ||
      (!configured && !secret)
    ) {
      showToast(
        "Integration id, secret for a new integration, repository, target, and timeout are required.",
        { variant: "destructive", pw: "custom-webhook-error" },
      );
      return;
    }
    start(async () => {
      const submittedId = config.id;
      const submittedEndpoint = endpoint;
      const submittedConfigured = configured;
      try {
        const { id: _id, generation, ...settings } = config;
        const body: Record<string, unknown> = { ...settings };
        if (submittedConfigured) body.generation = generation;
        if (secret) body.secret = secret;
        const response = await apiFetch(submittedEndpoint!, {
          method: submittedConfigured ? "PUT" : "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          cache: "no-store",
        });
        if (!response.ok) {
          showToast("Unable to save custom webhook configuration.", {
            variant: "destructive",
            pw: "custom-webhook-error",
          });
          return;
        }
        const saved = (await response.json()) as { version: number; generation?: string };
        if (latestId.current !== submittedId) return;
        setConfig((current) => ({
          ...current,
          version: saved.version,
          generation: saved.generation,
        }));
        setConfigured(true);
        setSecret("");
        showToast("Custom webhook configuration saved.", { pw: "custom-webhook-success" });
      } catch {
        showToast("Unable to save custom webhook configuration.", {
          variant: "destructive",
          pw: "custom-webhook-error",
        });
      }
    });
  };

  const remove = async () => {
    try {
      const response = await apiFetch(endpoint!, {
        method: "DELETE",
        headers: {
          "if-match": String(config.version!),
          "if-match-generation": config.generation ?? "legacy",
        },
        cache: "no-store",
      });
      if (!response.ok) {
        showToast("Unable to delete custom webhook configuration.", {
          variant: "destructive",
          pw: "custom-webhook-error",
        });
        return { ok: false as const, error: "Unable to delete custom webhook configuration." };
      }
      setConfig({ ...emptyConfig });
      setSecret("");
      setConfigured(false);
      showToast("Custom webhook configuration deleted.", { pw: "custom-webhook-success" });
    } catch {
      showToast("Unable to delete custom webhook configuration.", {
        variant: "destructive",
        pw: "custom-webhook-error",
      });
      return { ok: false as const, error: "Unable to delete custom webhook configuration." };
    }
  };

  const updateTarget = (target: Target, index?: number) => {
    if (index === undefined) setConfig((current) => ({ ...current, target }));
    else
      setConfig((current) => ({
        ...current,
        fallbacks: current.fallbacks.map((item, i) => (i === index ? target : item)),
      }));
  };

  return (
    <Card data-pw="custom-webhook-settings-card">
      <CardHeader>
        <CardTitle>Custom inbound webhook</CardTitle>
        <p className="text-sm text-muted-foreground">
          Configure an HMAC-protected sender. Callers may send only prompt, idempotencyKey, and ref;
          routing stays here.
        </p>
      </CardHeader>
      <CardContent>
        <form className="grid gap-3" onSubmit={save}>
          <div className="space-y-1">
            <Label htmlFor="custom-webhook-id">Integration id</Label>
            <div className="flex gap-2">
              <Input
                id="custom-webhook-id"
                value={config.id}
                onChange={(event) => {
                  latestId.current = event.target.value;
                  setConfig((current) => ({
                    ...current,
                    id: event.target.value,
                    version: undefined,
                  }));
                  // A loaded configuration only authorizes PUT/DELETE for its exact ID.
                  setConfigured(false);
                }}
                placeholder="deploy"
                data-pw="custom-webhook-id"
              />
              <Button
                type="button"
                variant="outline"
                onClick={load}
                disabled={pending}
                data-pw="custom-webhook-load"
              >
                Load
              </Button>
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="custom-webhook-queue-ttl">Queue TTL (seconds)</Label>
              <Input
                id="custom-webhook-queue-ttl"
                type="number"
                min="1"
                value={config.queueTtlSeconds}
                onChange={(event) =>
                  setConfig((current) => ({
                    ...current,
                    queueTtlSeconds: Number(event.target.value),
                  }))
                }
                data-pw="custom-webhook-queue-ttl"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="custom-webhook-priority">Priority</Label>
              <Input
                id="custom-webhook-priority"
                type="number"
                value={config.priority}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, priority: Number(event.target.value) }))
                }
                data-pw="custom-webhook-priority"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Required labels (up to 16)</Label>
            {config.requiredLabels.map((label, index) => (
              <div className="flex gap-2" key={`label-${index}`}>
                <Input
                  value={label}
                  onChange={(event) =>
                    setConfig((current) => ({
                      ...current,
                      requiredLabels: current.requiredLabels.map((item, i) =>
                        i === index ? event.target.value : item,
                      ),
                    }))
                  }
                  aria-label={`Required label ${index + 1}`}
                  data-pw={`custom-webhook-label-${index}`}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      requiredLabels: current.requiredLabels.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {config.requiredLabels.length < 16 && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setConfig((current) => ({
                    ...current,
                    requiredLabels: [...current.requiredLabels, ""],
                  }))
                }
                data-pw="custom-webhook-add-label"
              >
                Add label
              </Button>
            )}
          </div>
          <div className="space-y-1">
            <Label htmlFor="custom-webhook-repository">Repository id</Label>
            <Input
              id="custom-webhook-repository"
              value={config.repositoryId}
              onChange={(event) =>
                setConfig((current) => ({ ...current, repositoryId: event.target.value }))
              }
              data-pw="custom-webhook-repository"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="custom-webhook-target-type">Target type</Label>
              <select
                id="custom-webhook-target-type"
                value={targetType(config.target)}
                onChange={(event) => updateTarget({ [event.target.value]: "" })}
                className="h-9 rounded-md border bg-background px-3 text-sm"
                data-pw="custom-webhook-target-type"
              >
                <option value="providerId">Provider</option>
                <option value="commandId">Command</option>
              </select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="custom-webhook-target">Target id</Label>
              <Input
                id="custom-webhook-target"
                value={config.target.providerId ?? config.target.commandId ?? ""}
                onChange={(event) =>
                  updateTarget({ [targetType(config.target)]: event.target.value })
                }
                data-pw="custom-webhook-target"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label>Fallback targets (up to 90)</Label>
            {config.fallbacks.map((fallback, index) => (
              <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]" key={`fallback-${index}`}>
                <select
                  value={targetType(fallback)}
                  onChange={(event) => updateTarget({ [event.target.value]: "" }, index)}
                  className="h-9 rounded-md border bg-background px-3 text-sm"
                  aria-label={`Fallback ${index + 1} type`}
                  data-pw={`custom-webhook-fallback-type-${index}`}
                >
                  <option value="providerId">Provider</option>
                  <option value="commandId">Command</option>
                </select>
                <Input
                  value={fallback.providerId ?? fallback.commandId ?? ""}
                  onChange={(event) =>
                    updateTarget({ [targetType(fallback)]: event.target.value }, index)
                  }
                  aria-label={`Fallback ${index + 1} id`}
                  data-pw={`custom-webhook-fallback-id-${index}`}
                />
                <Button
                  type="button"
                  variant="outline"
                  onClick={() =>
                    setConfig((current) => ({
                      ...current,
                      fallbacks: current.fallbacks.filter((_, i) => i !== index),
                    }))
                  }
                >
                  Remove
                </Button>
              </div>
            ))}
            {config.fallbacks.length < 90 && (
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  setConfig((current) => ({
                    ...current,
                    fallbacks: [...current.fallbacks, { providerId: "" }],
                  }))
                }
                data-pw="custom-webhook-add-fallback"
              >
                Add fallback
              </Button>
            )}
          </div>
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="custom-webhook-timeout">Timeout (seconds)</Label>
              <Input
                id="custom-webhook-timeout"
                type="number"
                min="1"
                value={config.timeout}
                onChange={(event) =>
                  setConfig((current) => ({ ...current, timeout: Number(event.target.value) }))
                }
                data-pw="custom-webhook-timeout"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="custom-webhook-secret">Signing secret (leave blank to retain)</Label>
              <Input
                id="custom-webhook-secret"
                type="password"
                autoComplete="new-password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                data-pw="custom-webhook-secret"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.enabled}
              onChange={(event) =>
                setConfig((current) => ({ ...current, enabled: event.target.checked }))
              }
              data-pw="custom-webhook-enabled"
            />
            Enabled
          </label>
          <div className="flex gap-2">
            <Button type="submit" disabled={pending} data-pw="custom-webhook-submit">
              {pending ? "Saving…" : configured ? "Save changes" : "Save"}
            </Button>
            {configured && (
              <ConfirmButton
                triggerLabel="Delete"
                confirmTitle="Delete custom webhook configuration?"
                confirmDescription="This permanently removes the stored custom webhook configuration. It cannot be undone."
                confirmLabel="Delete configuration"
                variant="destructive"
                disabled={pending}
                pw="custom-webhook-delete"
                onConfirm={remove}
              />
            )}
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
