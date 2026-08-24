"use client";

import { useRouter } from "next/navigation";
import { Button } from "@auto-harness/ui";

export function ListApiError({
  resource,
  message,
  selector,
}: {
  resource: string;
  message: string;
  selector: string;
}) {
  const router = useRouter();

  return (
    <div
      className="rounded-md border border-destructive/40 bg-destructive/5 p-4"
      role="alert"
      data-pw={`${selector}-api-error`}
    >
      <p className="font-medium">Could not load {resource}.</p>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
      <Button
        className="mt-3"
        size="sm"
        variant="outline"
        type="button"
        onClick={() => router.refresh()}
        data-pw={`${selector}-api-retry`}
      >
        Try again
      </Button>
    </div>
  );
}

export function ListLoadingSkeleton({
  label,
  selector,
  rows = 5,
}: {
  label: string;
  selector: string;
  rows?: number;
}) {
  return (
    <div
      className="space-y-4"
      aria-busy="true"
      aria-live="polite"
      role="status"
      data-pw={`${selector}-loading`}
    >
      <span className="sr-only">Loading {label}…</span>
      <div className="h-8 w-48 animate-pulse rounded-sm bg-muted" aria-hidden="true" />
      <div className="space-y-2 rounded-md border border-border p-4" aria-hidden="true">
        {Array.from({ length: rows }, (_, index) => (
          <div className="h-10 animate-pulse rounded-sm bg-muted/70" key={index} />
        ))}
      </div>
    </div>
  );
}
