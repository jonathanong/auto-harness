import type { SessionArtifactsResponse, SessionOutputResponse } from "@auto-harness/shared";

export type ArtifactStatus =
  | Exclude<SessionArtifactsResponse, { state: "ready" }>
  | {
      state: "ready";
      expiresAt: string;
      capturedAt: string;
      contentType: "application/gzip";
      filename: "artifacts.tar.gz";
      compressedBytes: number;
      sha256: string;
    };

function ErrorMessage({ error }: { error: { code: string; message: string } }) {
  return (
    <p role="status" data-pw="session-output-error" className="text-sm text-amber-800">
      {error.message} ({error.code})
    </p>
  );
}

export function OutputState({ response }: { response: SessionOutputResponse | null }) {
  if (response === null) return <p role="status">Loading output…</p>;
  if (response.state === "unsupported") return <p>Outputs are not supported by this host.</p>;
  if (response.state === "pending") return <p role="status">Output is still being collected.</p>;
  if (response.state === "none") return <p>No output was captured for this session.</p>;
  if (response.state === "error") return <ErrorMessage error={response.error} />;
  if (response.state !== "ready") return null;
  let formattedOutput: string;
  try {
    formattedOutput = JSON.stringify(response.output, null, 2) ?? "undefined";
  } catch {
    return (
      <p role="alert" data-pw="session-output-render-error">
        Captured output is too deeply nested to display.
      </p>
    );
  }
  return (
    <div className="space-y-2" data-pw="session-output-ready">
      <p className="text-xs text-muted-foreground">Captured {response.capturedAt}</p>
      <pre className="max-h-[32rem] overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-4 text-sm">
        {formattedOutput}
      </pre>
    </div>
  );
}

export function ArtifactState({ response }: { response: ArtifactStatus | null }) {
  if (response === null) return <p role="status">Loading artifacts…</p>;
  if (response.state === "unsupported") return <p>Artifacts are not supported by this host.</p>;
  if (response.state === "pending")
    return <p role="status">Artifacts are still being collected.</p>;
  if (response.state === "none") return <p>No artifacts were captured for this session.</p>;
  if (response.state === "error") return <ErrorMessage error={response.error} />;
  if (response.state !== "ready") return null;
  return (
    <div className="space-y-2" data-pw="session-artifacts-ready">
      <p className="text-sm">
        {response.filename} · {response.compressedBytes.toLocaleString()} bytes
      </p>
      <p className="break-all font-mono text-xs text-muted-foreground">SHA-256 {response.sha256}</p>
      <p className="text-xs text-muted-foreground">Captured {response.capturedAt}</p>
    </div>
  );
}
