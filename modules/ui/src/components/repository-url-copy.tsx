"use client";

import { useState } from "react";

type CopyState = "idle" | "copied" | "failed";

export function RepositoryUrlCopy({ repositoryId, url }: { repositoryId: string; url: string }) {
  const [state, setState] = useState<CopyState>("idle");

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(url);
      setState("copied");
    } catch {
      setState("failed");
    }
  }

  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className="max-w-md truncate font-mono text-xs text-muted-foreground"
        title={url}
        data-pw={`repository-url-${repositoryId}`}
      >
        {url}
      </span>
      <button
        type="button"
        className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:underline"
        onClick={copyUrl}
        data-pw={`repository-url-copy-${repositoryId}`}
        aria-label={`Copy Git URL for ${repositoryId}`}
      >
        {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}
      </button>
      <span className="sr-only" role="status" aria-live="polite">
        {state === "copied"
          ? `Copied Git URL for ${repositoryId}`
          : state === "failed"
            ? `Could not copy Git URL for ${repositoryId}`
            : ""}
      </span>
    </div>
  );
}
