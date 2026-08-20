"use client";

import { useState } from "react";
import { Input, Label, Switch } from "@auto-harness/ui";

function priorityBand(priority: number): string {
  if (priority >= 75) return "critical";
  if (priority >= 50) return "high";
  if (priority >= 25) return "normal";
  return "low";
}

export function SessionPriorityLabelFields({
  availableLabels,
  initialPriority = 0,
  initialRequiredLabels = [],
}: {
  availableLabels: string[];
  initialPriority?: number;
  initialRequiredLabels?: string[];
}) {
  const [priority, setPriority] = useState(initialPriority);
  const required = new Set(initialRequiredLabels);

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
          min={Math.min(0, initialPriority)}
          max={Math.max(100, initialPriority)}
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
          <div className="space-y-2">
            {availableLabels.map((label) => {
              const id = `create-session-label-${label}`;
              return (
                <div key={label} className="flex items-center gap-2">
                  <Switch
                    id={id}
                    name="requiredLabels"
                    value={label}
                    defaultChecked={required.has(label)}
                    data-pw={id}
                  />
                  <Label htmlFor={id}>{label}</Label>
                </div>
              );
            })}
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
