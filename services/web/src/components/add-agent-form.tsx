"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { emptyHostInventory } from "@auto-harness/shared";
import { Button, Input, Label } from "@auto-harness/ui";

import { apiBase } from "../lib/api.ts";

/** Control-plane: seed a host inventory slot (agent may be offline). */
export function AddAgentForm() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  return (
    <form
      className="grid max-w-lg gap-3"
      data-pw="form-add-agent"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setOk(null);
        const form = e.currentTarget;
        const fd = new FormData(form);
        const agentId = String(fd.get("agentId") ?? "").trim();
        if (!agentId) {
          setError("agentId is required");
          return;
        }
        start(async () => {
          const body = emptyHostInventory();
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
          setOk(
            `Agent slot ${agentId} created (empty inventory). Run: HARNESS_AGENT_ID=${agentId} pnpm local:agent start`,
          );
          form.reset();
          router.refresh();
        });
      }}
    >
      <div className="space-y-1">
        <Label htmlFor="agentId">agentId</Label>
        <Input id="agentId" name="agentId" required placeholder="local-1" data-pw="add-agent-id" />
        <p className="text-xs text-muted-foreground">
          Identity for the daemon env <code>HARNESS_AGENT_ID</code>. Does not start a process — only
          seeds host inventory on the control plane.
        </p>
      </div>
      {error ? (
        <p className="text-sm text-red-700" data-pw="add-agent-error">
          {error}
        </p>
      ) : null}
      {ok ? (
        <p className="text-sm text-emerald-700" data-pw="add-agent-ok">
          {ok}
        </p>
      ) : null}
      <Button type="submit" disabled={pending} data-pw="add-agent-submit">
        {pending ? "Creating…" : "Add agent"}
      </Button>
    </form>
  );
}
