"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { mutateInventory, updateHostSetupScript } from "@auto-harness/shared";
import { Button } from "./button.tsx";
import { Label } from "./label.tsx";
import { Textarea } from "./textarea.tsx";
import { showToast } from "./toast.tsx";
import { WithTooltip } from "./tooltip.tsx";

export function HostSetupScriptForm({
  hostId,
  setupScript,
  mutate = mutateInventory,
}: Readonly<{
  hostId: string;
  setupScript?: string | undefined;
  mutate?: typeof mutateInventory;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [script, setScript] = useState(setupScript ?? "");

  useEffect(() => {
    setScript(setupScript ?? "");
    setSaved(false);
  }, [setupScript]);

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
              updateHostSetupScript(current, script),
            );
            if (!result.ok) {
              showToast(result.error, { variant: "destructive", pw: "host-setup-script-error" });
              return;
            }
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
