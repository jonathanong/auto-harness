"use client";

import { useState } from "react";
import { Button, Label, Textarea } from "@auto-harness/ui";

import { PromptMarkdownPreview } from "./prompt-markdown-preview.tsx";

export function SessionPromptField({ initialValue = "" }: { initialValue?: string }) {
  const [prompt, setPrompt] = useState(initialValue);
  const [preview, setPreview] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <Label
          htmlFor={preview ? undefined : "prompt"}
          tip="Prompt text passed to the resolved command"
        >
          Prompt
        </Label>
        <div className="flex gap-1" role="group" aria-label="Prompt view">
          <Button
            type="button"
            size="sm"
            variant={preview ? "ghost" : "outline"}
            aria-pressed={!preview}
            data-pw="create-session-prompt-write"
            onClick={() => setPreview(false)}
          >
            Write
          </Button>
          <Button
            type="button"
            size="sm"
            variant={preview ? "outline" : "ghost"}
            aria-pressed={preview}
            data-pw="create-session-prompt-preview-toggle"
            disabled={!prompt}
            onClick={() => setPreview(true)}
          >
            Preview
          </Button>
        </div>
      </div>
      <Textarea
        id="prompt"
        name={preview ? undefined : "prompt"}
        required={!preview}
        disabled={preview}
        hidden={preview}
        rows={6}
        value={prompt}
        onChange={(event) => setPrompt(event.currentTarget.value)}
        data-pw="create-session-prompt"
      />
      {preview ? (
        <>
          <input type="hidden" name="prompt" value={prompt} readOnly />
          <div
            className="min-h-36 rounded-md border border-border bg-background p-3"
            data-pw="create-session-prompt-preview"
            aria-live="polite"
          >
            <PromptMarkdownPreview value={prompt} />
          </div>
        </>
      ) : null}
    </div>
  );
}
