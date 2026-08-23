"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  mutateInventory,
  updateHostRequiredEnvironment,
  updateHostSetupScript,
} from "@auto-harness/shared";
import { Button } from "./button.tsx";
import { Label } from "./label.tsx";
import { Textarea } from "./textarea.tsx";
import { showToast } from "./toast.tsx";
import { WithTooltip } from "./tooltip.tsx";

export function HostSetupScriptForm({
  hostId,
  setupScript,
  requiredEnvironment,
  mutate = mutateInventory,
}: Readonly<{
  hostId: string;
  setupScript?: string | undefined;
  requiredEnvironment?: string[] | undefined;
  mutate?: typeof mutateInventory;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [script, setScript] = useState(setupScript ?? "");
  const [environment, setEnvironment] = useState((requiredEnvironment ?? []).join("\n"));
  const savedRefreshScriptRef = useRef<string | null>(null);

  useEffect(() => {
    const nextScript = setupScript ?? "";
    const preserveSavedFeedback = savedRefreshScriptRef.current === nextScript;
    savedRefreshScriptRef.current = null;
    setScript(nextScript);
    if (!preserveSavedFeedback) setSaved(false);
  }, [setupScript]);

  useEffect(() => {
    setEnvironment((requiredEnvironment ?? []).join("\n"));
  }, [requiredEnvironment]);

  return (
    <form
      className="space-y-3"
      data-pw="form-host-setup-script"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        start(async () => {
          try {
            const result = await mutate(hostId, (current) =>
              updateHostRequiredEnvironment(
                updateHostSetupScript(current, script),
                environment.split(/[\s,]+/).filter(Boolean),
              ),
            );
            if (!result.ok) {
              showToast(result.error, { variant: "destructive", pw: "host-setup-script-error" });
              return;
            }
            savedRefreshScriptRef.current = script;
            setSaved(true);
            router.refresh();
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "destructive",
              pw: "host-setup-script-error",
            });
          }
        });
      }}
    >
      <div className="space-y-1">
        <Label
          htmlFor="hostSetupScript"
          tip="Optional host-wide setup run before repository and worktree setup scripts"
        >
          Host Setup Script
        </Label>
        <Textarea
          id="hostSetupScript"
          name="setupScript"
          rows={6}
          value={script}
          onChange={(event) => setScript(event.target.value)}
          className="font-mono text-xs"
          data-pw="host-setup-script"
        />
      </div>
      <div className="space-y-1">
        <Label
          htmlFor="hostRequiredEnvironment"
          tip="Variable names every repository child process on this host requires"
        >
          Required Environment
        </Label>
        <Textarea
          id="hostRequiredEnvironment"
          name="requiredEnvironment"
          rows={4}
          value={environment}
          onChange={(event) => setEnvironment(event.target.value)}
          className="font-mono text-xs"
          data-pw="host-required-environment"
        />
      </div>
      <div className="flex items-center gap-3">
        <WithTooltip tip="Save only the host-wide setup script">
          <Button type="submit" disabled={pending} data-pw="host-setup-script-submit">
            {pending ? "Saving…" : "Save host setup"}
          </Button>
        </WithTooltip>
        {saved ? (
          <span className="text-sm text-emerald-700" data-pw="host-setup-script-ok">
            Saved.
          </span>
        ) : null}
      </div>
    </form>
  );
}
