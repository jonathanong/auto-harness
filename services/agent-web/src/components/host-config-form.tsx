"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Button, Label, Textarea } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

export function HostConfigForm({ agentId, initialJson }: { agentId: string; initialJson: string }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState(false);

  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setOk(false);
        const raw = String(new FormData(e.currentTarget).get("configJson") ?? "");
        let body: unknown;
        try {
          body = JSON.parse(raw) as unknown;
        } catch {
          setError("Invalid JSON");
          return;
        }
        start(async () => {
          const res = await fetch(
            `${apiBase()}/api/v1/agents/${encodeURIComponent(agentId)}/config`,
            {
              method: "PUT",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body),
            },
          );
          if (!res.ok) {
            setError(await res.text());
            return;
          }
          setOk(true);
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="configJson">host config JSON</Label>
        <Textarea
          id="configJson"
          name="configJson"
          rows={18}
          required
          defaultValue={initialJson}
          className="font-mono text-xs"
        />
      </div>
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      {ok ? <p className="text-sm text-emerald-700">Saved.</p> : null}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving…" : "Save host config"}
      </Button>
    </form>
  );
}
