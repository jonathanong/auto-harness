"use client";

import { Button, Label, Textarea } from "@auto-harness/ui";
import { MAX_REQUIRED_LABELS } from "@auto-harness/shared";

export function BindingRequiredLabels({
  bindingIndex,
  labels,
  onChange,
}: {
  bindingIndex: number;
  labels: string[];
  onChange: (labels: string[]) => void;
}) {
  return (
    <div className="space-y-1">
      <Label>Required labels (up to {MAX_REQUIRED_LABELS})</Label>
      {labels.map((label, labelIndex) => (
        <div className="flex gap-2" key={labelIndex}>
          <Textarea
            aria-label={`Required label ${labelIndex + 1}`}
            value={label}
            onChange={(event) =>
              onChange(labels.map((item, i) => (i === labelIndex ? event.target.value : item)))
            }
            data-pw={`github-ingress-label-${bindingIndex}-${labelIndex}`}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => onChange(labels.filter((_, i) => i !== labelIndex))}
          >
            Remove
          </Button>
        </div>
      ))}
      {labels.length < MAX_REQUIRED_LABELS && (
        <Button
          type="button"
          variant="outline"
          onClick={() => onChange([...labels, ""])}
          data-pw={`github-ingress-add-label-${bindingIndex}`}
        >
          Add label
        </Button>
      )}
    </div>
  );
}
