"use client";

import { useState } from "react";

import { Button } from "./button.tsx";

type CopyState = "idle" | "copied" | "failed";

const COPY_LABEL: Record<CopyState, string> = {
  idle: "Copy prompt",
  copied: "Copied",
  failed: "Copy failed",
};

export function argvDisplay(
  resolvedArgv: string[],
  prompt?: string | null,
): { tokens: string[]; appendedPrompt: boolean; joined: string } {
  if (resolvedArgv.length === 0) return { tokens: [], appendedPrompt: false, joined: "" };
  const appendedPrompt = Boolean(prompt && resolvedArgv.at(-1) === prompt);
  return {
    tokens: appendedPrompt ? resolvedArgv.slice(0, -1) : resolvedArgv,
    appendedPrompt,
    joined: resolvedArgv.join(" "),
  };
}

function CopyPromptButton({ prompt }: { prompt: string }) {
  const [state, setState] = useState<CopyState>("idle");
  return (
    <span className="inline-flex items-center gap-2">
      <Button
        type="button"
        size="sm"
        variant="ghost"
        aria-label="Copy prompt"
        data-pw="session-detail-copy-prompt"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(prompt);
            setState("copied");
          } catch {
            setState("failed");
          }
        }}
      >
        {COPY_LABEL[state]}
      </Button>
      {state === "idle" ? null : (
        <span className="sr-only" role="status" data-pw="session-detail-copy-prompt-status">
          {state === "copied" ? "Prompt copied" : "Could not copy prompt"}
        </span>
      )}
    </span>
  );
}

/** Prompt body plus tokenized spawned argv, with the appended prompt elided. */
export function SessionPromptPanel({
  prompt,
  resolvedArgv,
}: {
  prompt?: string | null | undefined;
  resolvedArgv?: string[] | null | undefined;
}) {
  const argv = argvDisplay(resolvedArgv ?? [], prompt);
  const assigned = argv.tokens.length > 0 || argv.appendedPrompt;
  const elidedLabel = [...argv.tokens, ...(argv.appendedPrompt ? ["‹prompt›"] : [])].join(" ");
  return (
    <div className="space-y-6">
      <section aria-labelledby="session-detail-prompt-heading" data-pw="session-detail-prompt">
        <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
          <div className="space-y-1">
            <h3
              id="session-detail-prompt-heading"
              className="text-xs uppercase text-muted-foreground"
            >
              Prompt
            </h3>
            <p className="text-xs text-muted-foreground">
              Session text submitted to the assigned command.
            </p>
          </div>
          {prompt ? <CopyPromptButton prompt={prompt} /> : null}
        </div>
        <pre
          className="max-h-[70vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-border bg-muted/50 p-4 font-sans text-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
          data-pw="session-detail-prompt-content"
          tabIndex={0}
        >
          {prompt ?? "—"}
        </pre>
      </section>
      <section data-pw="session-detail-resolved-argv-section">
        <h3 className="text-xs uppercase text-muted-foreground">Resolved argv</h3>
        <p className="mt-1 text-xs text-muted-foreground">
          Command actually spawned. The session prompt is appended as the last argument when the
          Command has appendPrompt.
        </p>
        {assigned ? (
          <div
            className="mt-2 flex flex-wrap gap-1.5 font-mono text-sm"
            data-pw="session-detail-resolved-argv"
            aria-label={elidedLabel}
            title={argv.joined}
          >
            {argv.tokens.map((token, index) => (
              <span
                key={`${index}-${token}`}
                aria-hidden="true"
                className="rounded-md border border-border bg-muted/50 px-2 py-0.5"
              >
                {token}
              </span>
            ))}
            {argv.appendedPrompt ? (
              <span
                aria-hidden="true"
                className="rounded-md border border-dashed border-border px-2 py-0.5 text-muted-foreground"
              >
                ‹prompt›
              </span>
            ) : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Not assigned yet.</p>
        )}
      </section>
    </div>
  );
}
