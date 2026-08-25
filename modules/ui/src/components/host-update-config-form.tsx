/* eslint-disable max-lines -- typed signed-update controls share one fenced save form. */
"use client";

import { useEffect, useRef, useState, useTransition } from "react";

import {
  mutateHostUpdateConfig,
  parseHostUpdateConfig,
  type HostUpdateConfig,
} from "@auto-harness/shared";
import { Alert } from "./alert.tsx";
import { Button } from "./button.tsx";
import { Input } from "./input.tsx";
import { Label } from "./label.tsx";
import { Textarea } from "./textarea.tsx";
import { showToast } from "./toast.tsx";
import { WithTooltip } from "./tooltip.tsx";

/** Render the persisted EnvironmentFile-safe key in the normal PEM form operators paste. */
function displayPublicKey(value: string | undefined): string {
  return value?.replaceAll("\\n", "\n") ?? "";
}

/** Structured, audited signed-update configuration for one host daemon. */
export function HostUpdateConfigForm({
  hostId,
  updateConfig,
  mutateUpdate = mutateHostUpdateConfig,
  canWriteExecConfig = false,
}: Readonly<{
  hostId: string;
  updateConfig?: HostUpdateConfig | undefined;
  mutateUpdate?: typeof mutateHostUpdateConfig;
  canWriteExecConfig?: boolean;
}>) {
  const [pending, start] = useTransition();
  const [saved, setSaved] = useState(false);
  const [enabled, setEnabled] = useState(updateConfig?.enabled ?? false);
  const [manifestUrl, setManifestUrl] = useState(updateConfig?.manifestUrl ?? "");
  const [publicKey, setPublicKey] = useState(displayPublicKey(updateConfig?.publicKey));
  const [installDir, setInstallDir] = useState(updateConfig?.installDir ?? "");
  const [pollMs, setPollMs] = useState(
    updateConfig?.pollMs === undefined ? "" : String(updateConfig.pollMs),
  );
  const [daemonVersion, setDaemonVersion] = useState(updateConfig?.daemonVersion ?? "");
  const dirty = useRef(false);

  useEffect(() => {
    if (dirty.current) return;
    setEnabled(updateConfig?.enabled ?? false);
    setManifestUrl(updateConfig?.manifestUrl ?? "");
    setPublicKey(displayPublicKey(updateConfig?.publicKey));
    setInstallDir(updateConfig?.installDir ?? "");
    setPollMs(updateConfig?.pollMs === undefined ? "" : String(updateConfig.pollMs));
    setDaemonVersion(updateConfig?.daemonVersion ?? "");
    setSaved(false);
  }, [updateConfig]);

  if (!canWriteExecConfig) return null;

  const markDirty = (): void => {
    dirty.current = true;
    setSaved(false);
  };

  return (
    <form
      className="space-y-3 border-t border-border pt-6"
      data-pw="form-host-update-config"
      onSubmit={(event) => {
        event.preventDefault();
        let next: HostUpdateConfig;
        try {
          const parsedPollMs = pollMs === "" ? undefined : Number(pollMs);
          next = parseHostUpdateConfig(
            enabled
              ? {
                  enabled,
                  manifestUrl,
                  publicKey,
                  ...(installDir === "" ? {} : { installDir }),
                  ...(parsedPollMs === undefined ? {} : { pollMs: parsedPollMs }),
                  ...(daemonVersion === "" ? {} : { daemonVersion }),
                }
              : { enabled: false },
          );
        } catch (error) {
          showToast(error instanceof Error ? error.message : String(error), {
            variant: "destructive",
            pw: "host-update-config-error",
          });
          return;
        }
        start(async () => {
          try {
            const result = await mutateUpdate(hostId, next);
            if (!result.ok) {
              showToast(result.error, { variant: "destructive", pw: "host-update-config-error" });
              return;
            }
            dirty.current = false;
            setSaved(true);
          } catch (error) {
            showToast(error instanceof Error ? error.message : String(error), {
              variant: "destructive",
              pw: "host-update-config-error",
            });
          }
        });
      }}
    >
      <div className="space-y-1">
        <h3 className="text-lg font-medium">Host daemon updates</h3>
        <p className="text-sm text-muted-foreground">
          Signed-update settings are stored for this Host. Rerun install-service, then restart the
          Host daemon so its root-owned update helper uses the same settings. A disabled setting
          overrides legacy service-environment update variables.
        </p>
      </div>
      <Alert variant="warning" role="alert" data-pw="host-update-config-alert">
        Changing the update trust key or artifact location can change host daemon code. These writes
        require the admin <code>fleet:exec-config</code> capability and are recorded in the audit
        log.
      </Alert>
      <label className="flex items-center gap-2 text-sm" htmlFor="hostUpdatesEnabled">
        <Input
          id="hostUpdatesEnabled"
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            markDirty();
            setEnabled(event.target.checked);
          }}
          data-pw="host-update-enabled"
        />
        Enable signed updates
      </label>
      {enabled ? (
        <div className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="hostUpdateManifestUrl" tip="HTTPS URL for the signed update manifest">
              Manifest URL
            </Label>
            <Input
              id="hostUpdateManifestUrl"
              type="url"
              value={manifestUrl}
              onChange={(event) => {
                markDirty();
                setManifestUrl(event.target.value);
              }}
              data-pw="host-update-manifest-url"
            />
          </div>
          <div className="space-y-1">
            <Label
              htmlFor="hostUpdatePublicKey"
              tip="Paste an Ed25519 PEM; line breaks are stored safely for the service environment"
            >
              Manifest public key
            </Label>
            <Textarea
              id="hostUpdatePublicKey"
              rows={6}
              value={publicKey}
              onChange={(event) => {
                markDirty();
                setPublicKey(event.target.value);
              }}
              className="font-mono text-xs"
              data-pw="host-update-public-key"
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            <div className="space-y-1">
              <Label htmlFor="hostUpdateInstallDir" tip="Optional absolute persistent update root">
                Install directory
              </Label>
              <Input
                id="hostUpdateInstallDir"
                value={installDir}
                onChange={(event) => {
                  markDirty();
                  setInstallDir(event.target.value);
                }}
                data-pw="host-update-install-dir"
              />
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="hostUpdatePollMs"
                tip="Optional poll interval in milliseconds; 0 checks once"
              >
                Poll interval (ms)
              </Label>
              <Input
                id="hostUpdatePollMs"
                type="number"
                min="0"
                value={pollMs}
                onChange={(event) => {
                  markDirty();
                  setPollMs(event.target.value);
                }}
                data-pw="host-update-poll-ms"
              />
            </div>
            <div className="space-y-1">
              <Label
                htmlFor="hostUpdateDaemonVersion"
                tip="Fallback semantic version before any active release marker"
              >
                Fallback version
              </Label>
              <Input
                id="hostUpdateDaemonVersion"
                value={daemonVersion}
                onChange={(event) => {
                  markDirty();
                  setDaemonVersion(event.target.value);
                }}
                data-pw="host-update-daemon-version"
              />
            </div>
          </div>
        </div>
      ) : null}
      <div className="flex items-center gap-3">
        <WithTooltip tip="Save signed-update configuration for this Host">
          <Button type="submit" disabled={pending} data-pw="host-update-config-submit">
            {pending ? "Saving…" : "Save host daemon updates"}
          </Button>
        </WithTooltip>
        {saved ? (
          <span className="text-sm text-emerald-700" data-pw="host-update-config-ok">
            Saved. Rerun install-service, then restart the Host daemon to apply it.
          </span>
        ) : null}
      </div>
    </form>
  );
}
