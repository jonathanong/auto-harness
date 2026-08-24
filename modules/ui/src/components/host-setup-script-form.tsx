"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  mutateExecConfig,
  mutateInventory,
  parseAllowedRoots,
  updateHostRequiredEnvironment,
} from "@auto-harness/shared";
import { Alert } from "./alert.tsx";
import { Button } from "./button.tsx";
import { Label } from "./label.tsx";
import { Textarea } from "./textarea.tsx";
import { showToast } from "./toast.tsx";
import { WithTooltip } from "./tooltip.tsx";

export function HostSetupScriptForm({
  hostId,
  setupScript,
  allowedRoots,
  requiredEnvironment,
  mutateExec = mutateExecConfig,
  mutateInv = mutateInventory,
  canWriteExecConfig = true,
  canWriteInventory = true,
}: Readonly<{
  hostId: string;
  setupScript?: string | undefined;
  allowedRoots?: string[] | undefined;
  requiredEnvironment?: string[] | undefined;
  mutateExec?: typeof mutateExecConfig;
  mutateInv?: typeof mutateInventory;
  canWriteExecConfig?: boolean;
  canWriteInventory?: boolean;
}>) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [script, setScript] = useState(setupScript ?? "");
  const [roots, setRoots] = useState((allowedRoots ?? []).join("\n"));
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
    setRoots((allowedRoots ?? []).join("\n"));
  }, [allowedRoots]);

  useEffect(() => {
    setEnvironment((requiredEnvironment ?? []).join("\n"));
  }, [requiredEnvironment]);

  if (!canWriteExecConfig && !canWriteInventory) return null;

  return (
    <form
      className="space-y-3"
      data-pw="form-host-setup-script"
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        start(async () => {
          try {
            if (canWriteExecConfig) {
              let parsedRoots: string[];
              try {
                parsedRoots =
                  parseAllowedRoots(
                    roots
                      .split(/[\n,]+/)
                      .map((line) => line.trim())
                      .filter(Boolean),
                  ) ?? [];
              } catch (error) {
                showToast(error instanceof Error ? error.message : String(error), {
                  variant: "destructive",
                  pw: "host-setup-script-error",
                });
                return;
              }
              const execResult = await mutateExec(hostId, () => ({
                setupScript: script,
                allowedRoots: parsedRoots,
              }));
              if (!execResult.ok) {
                showToast(execResult.error, {
                  variant: "destructive",
                  pw: "host-setup-script-error",
                });
                return;
              }
            }
            if (canWriteInventory) {
              const inventoryResult = await mutateInv(hostId, (current) =>
                updateHostRequiredEnvironment(current, environment.split(/[\s,]+/).filter(Boolean)),
              );
              if (!inventoryResult.ok) {
                showToast(inventoryResult.error, {
                  variant: "destructive",
                  pw: "host-setup-script-error",
                });
                return;
              }
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
      {canWriteExecConfig ? (
        <Alert variant="warning" role="alert" data-pw="host-exec-config-alert">
          Changing setup scripts, terminal hooks, or allowed roots permits arbitrary execution on
          this host. These writes require the admin <code>fleet:exec-config</code> capability and
          are recorded in the audit log.
        </Alert>
      ) : null}
      {canWriteExecConfig ? (
        <>
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
              htmlFor="hostAllowedRoots"
              tip="Absolute directories executable paths and inventory filesystem paths must resolve under. Leave blank for no extra restriction."
            >
              Allowed Roots
            </Label>
            <Textarea
              id="hostAllowedRoots"
              name="allowedRoots"
              rows={4}
              value={roots}
              onChange={(event) => setRoots(event.target.value)}
              className="font-mono text-xs"
              data-pw="host-allowed-roots"
            />
          </div>
        </>
      ) : null}
      {canWriteInventory ? (
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
      ) : null}
      <div className="flex items-center gap-3">
        <WithTooltip tip="Save host exec-config and required environment">
          <Button type="submit" disabled={pending} data-pw="host-setup-script-submit">
            {pending ? "Saving…" : "Save host setup and environment"}
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
