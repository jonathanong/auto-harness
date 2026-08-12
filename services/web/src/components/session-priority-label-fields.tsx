"use client";

import { useState } from "react";
import { Input, Label } from "@auto-harness/ui";

function priorityBand(priority: number): string {
  if (priority >= 75) return "critical";
  if (priority >= 50) return "high";
  if (priority >= 25) return "normal";
  return "low";
}

export function SessionPriorityLabelFields({ availableLabels }: { availableLabels: string[] }) {
  const [priority, setPriority] = useState(0);

  return (
    <div className="space-y-4" data-pw="create-session-scheduling-fields">
      <div className="space-y-1">
        <Label htmlFor="priority" tip="Higher-priority sessions are assigned before lower ones">
          Priority
        </Label>
        <Input
          id="priority"
          name="priority"
          type="range"
          min={0}
          max={100}
          step={1}
          value={priority}
          onChange={(event) => setPriority(Number(event.currentTarget.value))}
          data-pw="create-session-priority"
        />
        <output
          htmlFor="priority"
          className="block text-xs text-muted-foreground"
          data-pw="create-session-priority-value"
        >
          {priority} ({priorityBand(priority)})
        </output>
      </div>
      <fieldset className="space-y-2" data-pw="create-session-labels">
        <legend className="text-sm font-medium">Required labels</legend>
        {availableLabels.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {availableLabels.map((label) => (
              <label
                key={label}
                className="cursor-pointer rounded-full border px-3 py-1 text-xs has-[:checked]:border-primary has-[:checked]:bg-primary has-[:checked]:text-primary-foreground"
              >
                <input
                  type="checkbox"
                  name="requiredLabels"
                  value={label}
                  className="sr-only"
                  data-pw={`create-session-label-${label}`}
                />
                {label}
              </label>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground" data-pw="create-session-labels-empty">
            No labels are advertised by online worktrees. This session can run on any worktree.
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          A worktree must have every selected label. Leave all unselected to allow any worktree.
        </p>
      </fieldset>
    </div>
  );
}
