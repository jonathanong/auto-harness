"use client";

import { useEffect, useState } from "react";

import type { SessionArchiveReadResponse } from "@auto-harness/shared";

import { Button } from "./button.tsx";
import { isSessionArchiveReadResponse } from "../lib/session-archive-response.ts";

const ARCHIVE_POLL_MS = 5_000;
const ARCHIVE_POLL_MAX_MS = 65_000;
export const ARCHIVE_REQUEST_TIMEOUT_MS = 15_000;

function archivePath(sessionId: string): string {
  return `/api/v1/sessions/${encodeURIComponent(sessionId)}/archive`;
}

function archiveRequest(timeoutMs = ARCHIVE_REQUEST_TIMEOUT_MS): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timer);
      if (!controller.signal.aborted) controller.abort();
    },
  };
}

async function fetchArchiveStatus(
  sessionId: string,
  signal: AbortSignal,
): Promise<SessionArchiveReadResponse> {
  const path = archivePath(sessionId);
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin", signal });
  if (!response.ok) throw new Error(`GET ${path} failed`);
  const body: unknown = await response.json();
  if (!isSessionArchiveReadResponse(body)) throw new Error("Invalid archive status response");
  return body;
}

function stateCopy(state: SessionArchiveReadResponse["state"] | null): string {
  if (state === "dynamodb") return "Recent transcript — not archived";
  if (state === "archived") return "Archived transcript is ready to download.";
  if (state === "incomplete") return "Archived transcript failed integrity verification.";
  if (state === "expired") return "Transcript expired before archival completed.";
  if (state === "unavailable") return "Archived transcript is unavailable for retrieval.";
  return "Checking transcript archive status…";
}

/** Shows durable transcript availability and mints a fresh JSONL download on demand. */
export function SessionArchiveStatus({
  sessionId,
  terminal,
  refreshToken = 0,
}: {
  sessionId: string;
  terminal: boolean;
  refreshToken?: number;
}) {
  const [archive, setArchive] = useState<SessionArchiveReadResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [manualRefresh, setManualRefresh] = useState(0);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: ReturnType<typeof archiveRequest> | undefined;
    const deadline = terminal ? Date.now() + ARCHIVE_POLL_MAX_MS : 0;

    const schedule = () => {
      if (!active || !terminal) return;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      timer = setTimeout(() => void refresh(true), Math.min(ARCHIVE_POLL_MS, remaining));
    };

    async function refresh(automatic: boolean): Promise<void> {
      if (!active) return;
      request?.dispose();
      request = archiveRequest();
      setLoading(true);
      try {
        const next = await fetchArchiveStatus(sessionId, request.signal);
        if (!active) return;
        setArchive(next);
        setError(null);
        if (automatic && next.state === "dynamodb") schedule();
      } catch {
        if (!active) return;
        setError("Archive status could not be loaded; retrying may help.");
        schedule();
      } finally {
        request?.dispose();
        request = undefined;
        if (active) setLoading(false);
      }
    }

    void refresh(true);
    return () => {
      active = false;
      request?.dispose();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [manualRefresh, refreshToken, sessionId, terminal]);

  const refresh = () => setManualRefresh((current) => current + 1);
  const download = async () => {
    setLoading(true);
    const request = archiveRequest();
    try {
      // Always mint a fresh URL immediately before starting a download.
      const next = await fetchArchiveStatus(sessionId, request.signal);
      setArchive(next);
      setError(null);
      if (next.state !== "archived") return;
      const anchor = document.createElement("a");
      anchor.href = next.downloadUrl;
      anchor.download = "session-logs.jsonl";
      anchor.rel = "noopener";
      anchor.style.display = "none";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
    } catch {
      setError("Archived transcript could not be downloaded.");
    } finally {
      request.dispose();
      setLoading(false);
    }
  };

  const state = archive?.state ?? null;
  return (
    <div
      className={`flex flex-wrap items-center gap-2 text-sm ${state === "unavailable" || state === "incomplete" || state === "expired" ? "text-amber-800" : ""}`}
      data-pw="session-archive-status"
    >
      <span aria-live="polite" data-pw="session-archive-state">
        {stateCopy(state)}
      </span>
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={refresh}
        disabled={loading}
        data-pw="session-archive-refresh"
      >
        {loading ? "Refreshing…" : "Refresh archive"}
      </Button>
      {state === "archived" ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => void download()}
          disabled={loading}
          data-pw="session-archive-download"
        >
          Download .jsonl
        </Button>
      ) : null}
      {error ? (
        <span className="text-destructive" role="alert" data-pw="session-archive-error">
          {error}
        </span>
      ) : null}
    </div>
  );
}
