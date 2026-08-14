"use client";

import { useState } from "react";

import { Button } from "./button.tsx";

type CopyState = "idle" | "copied" | "failed";

const BUTTON_LABEL: Record<CopyState, string> = {
  idle: "Copy ID",
  copied: "Copied",
  failed: "Copy failed",
};

export function SessionIdCopyButton({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<CopyState>("idle");

  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Copy session ID"
        data-pw="session-detail-copy-id"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(sessionId);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {BUTTON_LABEL[state]}
      </Button>
      {state === "idle" ? null : (
        <span className="sr-only" role="status" data-pw="session-detail-copy-status">
          {state === "copied" ? "Session ID copied" : "Could not copy session ID"}
        </span>
      )}
    </span>
  );
}
