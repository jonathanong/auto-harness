/* eslint-disable max-lines -- load, save, and field controls share one settings form. */
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
  showToast,
} from "@auto-harness/ui";
import {
  DEFAULT_SESSION_LOG_SETTINGS,
  SESSION_LOG_UPLOAD_MODES,
  type PublicSessionLogSettings,
  type SessionLogUploadMode,
} from "@auto-harness/shared";

import { apiFetch } from "../lib/client-api.ts";

export function SessionLogSettingsForm() {
  const [pending, start] = useTransition();
  const [loadState, setLoadState] = useState<"loading" | "ready" | "forbidden" | "error">(
    "loading",
  );
  const [version, setVersion] = useState(0);
  const [uploadMode, setUploadMode] = useState<SessionLogUploadMode>(
    DEFAULT_SESSION_LOG_SETTINGS.uploadMode,
  );
  const [batchMaxKb, setBatchMaxKb] = useState(String(DEFAULT_SESSION_LOG_SETTINGS.batchMaxKb));
  const [batchMaxLines, setBatchMaxLines] = useState(
    String(DEFAULT_SESSION_LOG_SETTINGS.batchMaxLines),
  );
  const [batchMaxWaitMs, setBatchMaxWaitMs] = useState(
    String(DEFAULT_SESSION_LOG_SETTINGS.batchMaxWaitMs),
  );
  const [controlPlanePollMs, setControlPlanePollMs] = useState(
    String(DEFAULT_SESSION_LOG_SETTINGS.controlPlanePollMs),
  );

  useEffect(() => {
    void apiFetch("/api/v1/session-log-settings", { cache: "no-store" })
      .then(async (response) => {
        if (response.status === 401 || response.status === 403) {
          setLoadState("forbidden");
          return;
        }
        if (!response.ok) {
          setLoadState("error");
          return;
        }
        const value = (await response.json()) as PublicSessionLogSettings;
        setUploadMode(value.uploadMode);
        setBatchMaxKb(String(value.batchMaxKb));
        setBatchMaxLines(String(value.batchMaxLines));
        setBatchMaxWaitMs(String(value.batchMaxWaitMs));
        setControlPlanePollMs(String(value.controlPlanePollMs));
        setVersion(value.version);
        setLoadState("ready");
      })
      .catch(() => {
        setLoadState("error");
      });
  }, []);

  if (loadState === "loading") {
    return <div className="space-y-3" aria-busy="true" data-pw="session-log-settings-loading" />;
  }
  if (loadState === "forbidden") {
    return (
      <div className="space-y-3" data-pw="session-log-settings-forbidden">
        <h3 className="text-lg font-medium">Session logs</h3>
        <p className="text-sm text-red-700" role="alert" data-pw="settings-forbidden-error">
          You do not have permission to manage global settings. Session log upload requires an
          unscoped admin account.
        </p>
      </div>
    );
  }
  if (loadState === "error") {
    return (
      <div className="space-y-3" data-pw="session-log-settings-error">
        <h3 className="text-lg font-medium">Session logs</h3>
        <p className="text-sm text-red-700" role="alert" data-pw="settings-load-error">
          Unable to load settings. Try again later.
        </p>
      </div>
    );
  }

  const save = () =>
    start(async () => {
      try {
        const response = await apiFetch("/api/v1/session-log-settings", {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            version,
            uploadMode,
            batchMaxKb: Number(batchMaxKb),
            batchMaxLines: Number(batchMaxLines),
            batchMaxWaitMs: Number(batchMaxWaitMs),
            controlPlanePollMs: Number(controlPlanePollMs),
          }),
        });
        if (!response.ok) {
          showToast("Unable to save session log settings.", {
            variant: "destructive",
            pw: "session-log-settings-error",
          });
          return;
        }
        const saved = (await response.json()) as PublicSessionLogSettings;
        setVersion(saved.version);
        setUploadMode(saved.uploadMode);
        setBatchMaxKb(String(saved.batchMaxKb));
        setBatchMaxLines(String(saved.batchMaxLines));
        setBatchMaxWaitMs(String(saved.batchMaxWaitMs));
        setControlPlanePollMs(String(saved.controlPlanePollMs));
        showToast("Session log settings saved.", { pw: "session-log-settings-success" });
      } catch {
        showToast("Unable to save session log settings.", {
          variant: "destructive",
          pw: "session-log-settings-error",
        });
      }
    });

  return (
    <Card data-pw="session-log-settings-card">
      <CardHeader>
        <CardTitle>Session logs</CardTitle>
      </CardHeader>
      <CardContent>
        <form
          className="space-y-4"
          data-pw="form-session-log-settings"
          onSubmit={(event) => {
            event.preventDefault();
            save();
          }}
        >
          <p className="text-sm text-muted-foreground">
            Default is off: autonomous runs do not upload transcript bodies. The control plane polls
            S3; a live PTY stream exists only on the host pane.
          </p>
          <div className="space-y-2">
            <Label htmlFor="session-log-upload-mode">Upload mode</Label>
            <select
              id="session-log-upload-mode"
              className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm"
              data-pw="session-log-upload-mode"
              value={uploadMode}
              onChange={(event) => setUploadMode(event.target.value as SessionLogUploadMode)}
            >
              {SESSION_LOG_UPLOAD_MODES.map((mode) => (
                <option key={mode} value={mode}>
                  {mode}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-log-batch-max-kb">Batch max KB</Label>
            <Input
              id="session-log-batch-max-kb"
              data-pw="session-log-batch-max-kb"
              type="number"
              min={1}
              value={batchMaxKb}
              onChange={(event) => setBatchMaxKb(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-log-batch-max-lines">Batch max lines</Label>
            <Input
              id="session-log-batch-max-lines"
              data-pw="session-log-batch-max-lines"
              type="number"
              min={1}
              value={batchMaxLines}
              onChange={(event) => setBatchMaxLines(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-log-batch-max-wait-ms">Batch max wait (ms)</Label>
            <Input
              id="session-log-batch-max-wait-ms"
              data-pw="session-log-batch-max-wait-ms"
              type="number"
              min={1000}
              value={batchMaxWaitMs}
              onChange={(event) => setBatchMaxWaitMs(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="session-log-control-plane-poll-ms">Control-plane poll (ms)</Label>
            <Input
              id="session-log-control-plane-poll-ms"
              data-pw="session-log-control-plane-poll-ms"
              type="number"
              min={5000}
              value={controlPlanePollMs}
              onChange={(event) => setControlPlanePollMs(event.target.value)}
            />
          </div>
          <Button type="submit" disabled={pending} data-pw="session-log-settings-save">
            {pending ? "Saving…" : "Save"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
