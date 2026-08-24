/* eslint-disable max-lines -- independently saved exec-config and environment forms share one host setup surface. */
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import {
  mutateExecConfig,
  mutateInventory,
  parseAllowedRoots,
  type HostExecConfigPatch,
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
  canWriteExecConfig = false,
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
  const [execPending, startExec] = useTransition();
  const [inventoryPending, startInventory] = useTransition();
  const [execSaved, setExecSaved] = useState(false);
  const [environmentSaved, setEnvironmentSaved] = useState(false);
  const [script, setScript] = useState(setupScript ?? "");
  const [roots, setRoots] = useState((allowedRoots ?? []).join("\n"));
  const [environment, setEnvironment] = useState((requiredEnvironment ?? []).join("\n"));
  const [scriptDirty, setScriptDirty] = useState(false);
  const [rootsDirty, setRootsDirty] = useState(false);
  const savedRefreshExecRef = useRef<string | null>(null);
  const savedRefreshEnvironmentRef = useRef<string | null>(null);

  useEffect(() => {
    const nextScript = setupScript ?? "";
    const nextRoots = (allowedRoots ?? []).join("\n");
    const refreshKey = JSON.stringify([nextScript, nextRoots]);
    const preserveSavedFeedback = savedRefreshExecRef.current === refreshKey;
    savedRefreshExecRef.current = null;
    setScript(nextScript);
    setRoots(nextRoots);
    setScriptDirty(false);
    setRootsDirty(false);
    if (!preserveSavedFeedback) setExecSaved(false);
  }, [allowedRoots, setupScript]);

  useEffect(() => {
    const nextEnvironment = (requiredEnvironment ?? []).join("\n");
    const preserveSavedFeedback = savedRefreshEnvironmentRef.current === nextEnvironment;
    savedRefreshEnvironmentRef.current = null;
    setEnvironment(nextEnvironment);
    if (!preserveSavedFeedback) setEnvironmentSaved(false);
  }, [requiredEnvironment]);

  if (!canWriteExecConfig && !canWriteInventory) return null;

  return (
    <div className="space-y-6">
      {canWriteExecConfig ? (
        <form
          className="space-y-3"
          data-pw="form-host-setup-script"
          onSubmit={(event) => {
            event.preventDefault();
            setExecSaved(false);
            startExec(async () => {
              try {
                const patch: HostExecConfigPatch = {};
                let parsedRoots: string[] | undefined;
                if (scriptDirty) patch.setupScript = script;
                if (rootsDirty) {
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
                  patch.allowedRoots = parsedRoots;
                }
                if (Object.keys(patch).length > 0) {
                  const execResult = await mutateExec(hostId, () => patch);
                  if (!execResult.ok) {
                    showToast(execResult.error, {
                      variant: "destructive",
                      pw: "host-setup-script-error",
                    });
                    return;
                  }
                }
                savedRefreshExecRef.current = JSON.stringify([script, roots]);
                setScriptDirty(false);
                setRootsDirty(false);
                setExecSaved(true);
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
          <Alert variant="warning" role="alert" data-pw="host-exec-config-alert">
            Changing setup scripts, terminal hooks, or allowed roots permits arbitrary execution on
            this host. These writes require the admin <code>fleet:exec-config</code>
            capability and are recorded in the audit log.
          </Alert>
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
              onChange={(event) => {
                setScript(event.target.value);
                setScriptDirty(true);
              }}
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
              onChange={(event) => {
                setRoots(event.target.value);
                setRootsDirty(true);
              }}
              className="font-mono text-xs"
              data-pw="host-allowed-roots"
            />
          </div>
          <div className="flex items-center gap-3">
            <WithTooltip tip="Save host exec-config">
              <Button type="submit" disabled={execPending} data-pw="host-setup-script-submit">
                {execPending ? "Saving…" : "Save host setup"}
              </Button>
            </WithTooltip>
            {execSaved ? (
              <span className="text-sm text-emerald-700" data-pw="host-setup-script-ok">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
      {canWriteInventory ? (
        <form
          className="space-y-3"
          data-pw="form-host-required-environment"
          onSubmit={(event) => {
            event.preventDefault();
            setEnvironmentSaved(false);
            startInventory(async () => {
              try {
                const inventoryResult = await mutateInv(hostId, (current) =>
                  updateHostRequiredEnvironment(
                    current,
                    environment.split(/[\s,]+/).filter(Boolean),
                  ),
                );
                if (!inventoryResult.ok) {
                  showToast(inventoryResult.error, {
                    variant: "destructive",
                    pw: "host-required-environment-error",
                  });
                  return;
                }
                savedRefreshEnvironmentRef.current = environment;
                setEnvironmentSaved(true);
                router.refresh();
              } catch (error) {
                showToast(error instanceof Error ? error.message : String(error), {
                  variant: "destructive",
                  pw: "host-required-environment-error",
                });
              }
            });
          }}
        >
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
            <WithTooltip tip="Save required environment">
              <Button
                type="submit"
                disabled={inventoryPending}
                data-pw="host-required-environment-submit"
              >
                {inventoryPending ? "Saving…" : "Save required environment"}
              </Button>
            </WithTooltip>
            {environmentSaved ? (
              <span className="text-sm text-emerald-700" data-pw="host-required-environment-ok">
                Saved.
              </span>
            ) : null}
          </div>
        </form>
      ) : null}
    </div>
  );
}
