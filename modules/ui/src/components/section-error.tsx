"use client";

import { useRouter } from "next/navigation";

import { Alert } from "./alert.tsx";
import { Button } from "./button.tsx";

export type SectionErrorProps = {
  /** What failed to load, e.g. "repositories" — used in "Could not load {resource}." */
  resource: string;
  message: string;
  /** `data-pw` root; the alert gets `${selector}-error`, the button `${selector}-retry`. */
  selector: string;
};

/**
 * Per-section failure state for a Server Component page: render this in place of an empty state
 * when a fetch feeding that section threw, so a genuine "nothing here" can't be confused with
 * "the request failed." Retry re-runs the page's own server fetches via `router.refresh()` —
 * the same mechanism `DrainButton` uses — rather than duplicating fetch logic client-side.
 */
export function SectionError({ resource, message, selector }: SectionErrorProps) {
  const router = useRouter();
  return (
    <Alert variant="danger" role="alert" className="space-y-2" data-pw={`${selector}-error`}>
      <p className="font-medium">Could not load {resource}.</p>
      <p className="text-xs">{message}</p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => router.refresh()}
        data-pw={`${selector}-retry`}
      >
        Try again
      </Button>
    </Alert>
  );
}
