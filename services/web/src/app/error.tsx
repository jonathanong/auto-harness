"use client";

import { Button } from "@auto-harness/ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <section
      className="space-y-3 rounded-lg border border-destructive/40 bg-red-50 p-5"
      role="alert"
    >
      <h2 className="text-lg font-semibold text-red-950" tabIndex={-1} autoFocus>
        This page could not be loaded
      </h2>
      <p className="text-sm text-red-900">
        The control plane did not return this view. Retry the request, or use the navigation to
        continue elsewhere.
      </p>
      <Button type="button" variant="outline" onClick={reset}>
        Retry
      </Button>
    </section>
  );
}
