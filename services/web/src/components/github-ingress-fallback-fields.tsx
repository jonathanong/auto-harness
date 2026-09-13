"use client";

import { Button, Input, Label } from "@auto-harness/ui";

export type FallbackTarget = { providerId: string } | { commandId: string };
type FallbackKind = "providerId" | "commandId";

function fallbackKind(fallback: FallbackTarget): FallbackKind {
  return "commandId" in fallback ? "commandId" : "providerId";
}

function fallbackId(fallback: FallbackTarget): string {
  return "commandId" in fallback ? fallback.commandId : fallback.providerId;
}

function fallbackTarget(kind: FallbackKind, id: string): FallbackTarget {
  return kind === "commandId" ? { commandId: id } : { providerId: id };
}

export function loadedFallbacks(fallbacks: Array<Record<string, string>>): FallbackTarget[] {
  return fallbacks.map((fallback) =>
    "providerId" in fallback
      ? { providerId: fallback.providerId ?? "" }
      : { commandId: fallback.commandId ?? "" },
  );
}

export function parsedFallbacks(fallbacks: FallbackTarget[]): FallbackTarget[] | undefined {
  const targets: FallbackTarget[] = [];
  for (const fallback of fallbacks) {
    const id = fallbackId(fallback).trim();
    if (!id) return undefined;
    targets.push(fallbackTarget(fallbackKind(fallback), id));
  }
  return targets;
}

export function BindingFallbacks({
  bindingIndex,
  fallbacks,
  onChange,
}: {
  bindingIndex: number;
  fallbacks: FallbackTarget[];
  onChange: (fallbacks: FallbackTarget[]) => void;
}) {
  return (
    <div className="space-y-1">
      <Label>Fallback targets</Label>
      {fallbacks.map((fallback, fallbackIndex) => {
        const kind = fallbackKind(fallback);
        return (
          <div className="grid gap-2 sm:grid-cols-[1fr_2fr_auto]" key={fallbackIndex}>
            <select
              aria-label={`Fallback ${fallbackIndex + 1} type`}
              value={kind}
              onChange={(event) =>
                onChange(
                  fallbacks.map((item, i) =>
                    i === fallbackIndex
                      ? fallbackTarget(
                          event.target.value === "commandId" ? "commandId" : "providerId",
                          "",
                        )
                      : item,
                  ),
                )
              }
              data-pw={`github-ingress-fallback-type-${bindingIndex}-${fallbackIndex}`}
            >
              <option value="providerId">Provider</option>
              <option value="commandId">Command</option>
            </select>
            <Input
              aria-label={`Fallback ${fallbackIndex + 1} id`}
              value={fallbackId(fallback)}
              onChange={(event) =>
                onChange(
                  fallbacks.map((item, i) =>
                    i === fallbackIndex
                      ? fallbackTarget(fallbackKind(item), event.target.value)
                      : item,
                  ),
                )
              }
              data-pw={`github-ingress-fallback-id-${bindingIndex}-${fallbackIndex}`}
            />
            <Button
              type="button"
              variant="outline"
              onClick={() => onChange(fallbacks.filter((_, i) => i !== fallbackIndex))}
            >
              Remove
            </Button>
          </div>
        );
      })}
      <Button
        type="button"
        variant="outline"
        onClick={() => onChange([...fallbacks, fallbackTarget("providerId", "")])}
        data-pw={`github-ingress-add-fallback-${bindingIndex}`}
      >
        Add fallback
      </Button>
    </div>
  );
}
