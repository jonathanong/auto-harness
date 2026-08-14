"use client";

import { Input, Label } from "@auto-harness/ui";
import { useState } from "react";

const TIMEOUT_PRESETS = [
  { value: "300", label: "5 minutes" },
  { value: "900", label: "15 minutes" },
  { value: "1800", label: "30 minutes" },
  { value: "3600", label: "1 hour" },
] as const;

type TimeoutChoice = (typeof TIMEOUT_PRESETS)[number]["value"] | "custom";

/** Create-session timeout presets with an explicit positive-seconds escape hatch. */
export function SessionTimeoutField({ initialSeconds = 600 }: { initialSeconds?: number | null }) {
  const initialValue = String(initialSeconds ?? 600);
  const initialChoice = TIMEOUT_PRESETS.some(({ value }) => value === initialValue)
    ? (initialValue as TimeoutChoice)
    : "custom";
  const [choice, setChoice] = useState<TimeoutChoice>(initialChoice);
  const [customSeconds, setCustomSeconds] = useState(initialValue);

  return (
    <fieldset className="space-y-2" data-pw="create-session-timeout-control">
      <legend className="text-sm font-medium">Timeout</legend>
      <div className="space-y-1">
        <Label htmlFor="timeoutPreset">Duration</Label>
        <select
          id="timeoutPreset"
          value={choice}
          onChange={(event) => setChoice(event.currentTarget.value as TimeoutChoice)}
          aria-describedby="timeout-help"
          className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
          data-pw="create-session-timeout"
        >
          {TIMEOUT_PRESETS.map((preset) => (
            <option key={preset.value} value={preset.value}>
              {preset.label}
            </option>
          ))}
          <option value="custom">Custom</option>
        </select>
      </div>
      {choice === "custom" ? (
        <div className="space-y-1">
          <Label htmlFor="timeout">Custom timeout (seconds)</Label>
          <Input
            id="timeout"
            name="timeout"
            type="number"
            required
            min={Number.MIN_VALUE}
            step="any"
            value={customSeconds}
            onChange={(event) => setCustomSeconds(event.currentTarget.value)}
            aria-describedby="timeout-help"
            data-pw="create-session-timeout-custom"
          />
        </div>
      ) : (
        <input type="hidden" name="timeout" value={choice} />
      )}
      <p id="timeout-help" className="text-xs text-muted-foreground">
        Maximum runtime before the agent stops the session.
      </p>
    </fieldset>
  );
}
