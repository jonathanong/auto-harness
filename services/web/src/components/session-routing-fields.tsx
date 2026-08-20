"use client";

import { useState } from "react";
import { Button, Label } from "@auto-harness/ui";
import type { SessionTarget, SessionTargetSelection } from "../session-target.ts";
import { SessionTargetSelect } from "./session-target-select.tsx";

/** Primary target plus an ordered, explicit fallback chain shared by sessions and schedules. */
export function SessionRoutingFields({
  targets,
  prefix,
  initialTarget,
  initialFallbacks,
}: {
  targets: SessionTarget[];
  prefix: "create-session" | "schedule";
  initialTarget?: SessionTargetSelection | null;
  initialFallbacks?: SessionTargetSelection[];
}) {
  const [nextKey, setNextKey] = useState(initialFallbacks?.length ?? 0);
  const [fallbacks, setFallbacks] = useState(() =>
    (initialFallbacks ?? []).map((_, index) => index),
  );
  const targetValue = initialTarget ? selectionValue(initialTarget) : undefined;
  const fallbackValues = (initialFallbacks ?? []).map(selectionValue);
  const addFallback = () => {
    setFallbacks((items) => [...items, nextKey]);
    setNextKey((key) => key + 1);
  };
  return (
    <div className="space-y-3" data-pw={`${prefix}-routing`}>
      <div className="space-y-1">
        <Label htmlFor={`${prefix}-target`} tip="Provider pool or named command to try first">
          Primary Target
        </Label>
        <SessionTargetSelect
          targets={targets}
          id={`${prefix}-target`}
          name="target"
          dataPw={`${prefix}-target`}
          defaultValue={targetValue}
        />
      </div>
      <div className="space-y-2 rounded-md border border-dashed border-border p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <Label tip="Targets are attempted in this order when the preceding target has no capacity">
              Fallbacks
            </Label>
            <p className="text-xs text-muted-foreground">
              Optional, ordered provider/command choices.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addFallback}
            data-pw={`${prefix}-fallback-add`}
          >
            Add fallback
          </Button>
        </div>
        {fallbacks.map((key, index) => (
          <div
            className="flex items-center gap-2"
            key={key}
            data-pw={`${prefix}-fallback-${index}`}
          >
            <span className="w-5 text-center text-xs text-muted-foreground">{index + 1}</span>
            <div className="min-w-0 flex-1">
              <SessionTargetSelect
                targets={targets}
                id={`${prefix}-fallback-${index}`}
                name="fallback"
                dataPw={`${prefix}-fallback-select-${index}`}
                optional
                defaultValue={fallbackValues[index]}
              />
            </div>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setFallbacks((items) => items.filter((_, i) => i !== index))}
              data-pw={`${prefix}-fallback-remove-${index}`}
            >
              Remove
            </Button>
            <div className="flex gap-1">
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={index === 0}
                onClick={() => setFallbacks((items) => move(items, index, index - 1))}
                data-pw={`${prefix}-fallback-up-${index}`}
                aria-label={`Move fallback ${index + 1} up`}
              >
                ↑
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                disabled={index === fallbacks.length - 1}
                onClick={() => setFallbacks((items) => move(items, index, index + 1))}
                data-pw={`${prefix}-fallback-down-${index}`}
                aria-label={`Move fallback ${index + 1} down`}
              >
                ↓
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function selectionValue(selection: SessionTargetSelection): string {
  return "providerId" in selection
    ? `provider:${selection.providerId}`
    : `command:${selection.commandId}`;
}

function move(items: number[], from: number, to: number): number[] {
  const next = [...items];
  const [item] = next.splice(from, 1);
  if (item !== undefined) next.splice(to, 0, item);
  return next;
}
