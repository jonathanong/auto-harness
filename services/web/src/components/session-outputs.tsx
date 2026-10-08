"use client";

import type { SessionArtifactsResponse, SessionOutputResponse } from "@auto-harness/shared";
import { useCallback, useEffect, useRef, useState } from "react";

import { apiFetch } from "../lib/client-api.ts";
import { ArtifactState, type ArtifactStatus, OutputState } from "./session-output-state.tsx";

const POLL_INTERVAL_MS = 5_000;
const MAX_AUTOMATIC_POLLS = 12;

async function getOutput(sessionId: string): Promise<SessionOutputResponse> {
  const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/output`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Output request failed (${response.status})`);
  return (await response.json()) as SessionOutputResponse;
}

async function getArtifacts(sessionId: string): Promise<SessionArtifactsResponse> {
  const response = await apiFetch(`/api/v1/sessions/${encodeURIComponent(sessionId)}/artifacts`, {
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`Artifacts request failed (${response.status})`);
  return (await response.json()) as SessionArtifactsResponse;
}

function withoutDownloadUrl(response: SessionArtifactsResponse): ArtifactStatus {
  if (response.state !== "ready") return response;
  const { downloadUrl: _downloadUrl, ...status } = response;
  return status;
}

export function SessionOutputs({ sessionId }: { sessionId: string }) {
  const [output, setOutput] = useState<SessionOutputResponse | null>(null);
  const [artifacts, setArtifacts] = useState<ArtifactStatus | null>(null);
  const [outputFailure, setOutputFailure] = useState<string | null>(null);
  const [artifactFailure, setArtifactFailure] = useState<string | null>(null);
  const [downloadFailure, setDownloadFailure] = useState<string | null>(null);
  const [automaticPolls, setAutomaticPolls] = useState(0);
  const automaticPollCount = useRef(0);
  const currentSessionId = useRef(sessionId);
  currentSessionId.current = sessionId;
  const refreshGeneration = useRef(0);
  const [refreshKey, setRefreshKey] = useState(0);
  const [downloading, setDownloading] = useState(false);

  const refresh = useCallback(async () => {
    const generation = ++refreshGeneration.current;
    const [outputResult, artifactsResult] = await Promise.allSettled([
      getOutput(sessionId),
      getArtifacts(sessionId),
    ]);
    if (generation !== refreshGeneration.current || currentSessionId.current !== sessionId) {
      return false;
    }
    const nextOutput = outputResult.status === "fulfilled" ? outputResult.value : null;
    const nextArtifacts = artifactsResult.status === "fulfilled" ? artifactsResult.value : null;
    if (nextOutput !== null) {
      setOutput(nextOutput);
      setOutputFailure(null);
    } else {
      setOutputFailure(
        outputResult.status === "rejected" && outputResult.reason instanceof Error
          ? outputResult.reason.message
          : "Output request failed",
      );
    }
    if (nextArtifacts !== null) {
      setArtifacts(withoutDownloadUrl(nextArtifacts));
      setArtifactFailure(null);
    } else {
      setArtifactFailure(
        artifactsResult.status === "rejected" && artifactsResult.reason instanceof Error
          ? artifactsResult.reason.message
          : "Artifacts request failed",
      );
    }
    return Boolean(nextOutput?.state === "pending" || nextArtifacts?.state === "pending");
  }, [sessionId]);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    automaticPollCount.current = 0;
    setAutomaticPolls(0);
    setOutput(null);
    setArtifacts(null);
    setOutputFailure(null);
    setArtifactFailure(null);
    const poll = async () => {
      const stillPending = await refresh();
      if (!active) return;
      const next = automaticPollCount.current + 1;
      automaticPollCount.current = next;
      setAutomaticPolls(next);
      if (next < MAX_AUTOMATIC_POLLS && stillPending) {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };
    void poll();
    return () => {
      active = false;
      refreshGeneration.current += 1;
      clearTimeout(timer);
    };
    // The refresh key restarts bounded polling after an explicit refresh.
  }, [refresh, refreshKey]);

  const pending = output?.state === "pending" || artifacts?.state === "pending";
  const retry = () => {
    automaticPollCount.current = 0;
    setAutomaticPolls(0);
    setOutput(null);
    setArtifacts(null);
    setRefreshKey((key) => key + 1);
  };

  const download = async () => {
    const requestedFor = sessionId;
    setDownloading(true);
    setDownloadFailure(null);
    try {
      const response = await getArtifacts(sessionId);
      if (currentSessionId.current !== requestedFor) return;
      if (response.state !== "ready") {
        setArtifacts(withoutDownloadUrl(response));
        return;
      }
      const link = document.createElement("a");
      link.href = response.downloadUrl;
      link.download = response.filename;
      link.rel = "noopener";
      link.click();
      link.remove();
    } catch (error) {
      if (currentSessionId.current === requestedFor) {
        setDownloadFailure(
          error instanceof Error ? error.message : "Artifact download request failed",
        );
      }
    } finally {
      if (currentSessionId.current === requestedFor) setDownloading(false);
    }
  };

  return (
    <section className="space-y-6" data-pw="session-outputs">
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Output</h2>
          {pending || outputFailure || artifactFailure ? (
            <button type="button" data-pw="session-output-refresh" onClick={retry}>
              Refresh status
            </button>
          ) : null}
        </div>
        {outputFailure ? (
          <p role="alert" data-pw="session-output-fetch-error">
            {outputFailure}
          </p>
        ) : (
          <OutputState response={output} />
        )}
      </div>
      {pending && automaticPolls >= MAX_AUTOMATIC_POLLS ? (
        <p role="status" data-pw="session-output-poll-paused">
          Automatic status refresh paused. Use Refresh status to check again.
        </p>
      ) : null}
      <div className="space-y-3 rounded-md border p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-medium">Artifacts</h2>
          {artifacts?.state === "ready" ? (
            <button
              type="button"
              data-pw="session-artifacts-download"
              onClick={() => void download()}
              disabled={downloading}
            >
              {downloading ? "Preparing download…" : "Download artifacts"}
            </button>
          ) : null}
        </div>
        {artifactFailure ? (
          <p role="alert" data-pw="session-artifacts-fetch-error">
            {artifactFailure}
          </p>
        ) : (
          <ArtifactState response={artifacts} />
        )}
        {downloadFailure ? (
          <p role="alert" data-pw="session-artifacts-download-error">
            {downloadFailure}
          </p>
        ) : null}
      </div>
    </section>
  );
}
