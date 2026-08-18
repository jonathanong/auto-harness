"use client";

import { Alert, Button } from "@auto-harness/ui";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <Alert variant="danger" role="alert" className="space-y-3 rounded-lg p-5">
      <h2 className="text-lg font-semibold" tabIndex={-1} autoFocus>
        This page could not be loaded
      </h2>
      <p className="text-sm">
        The control plane did not return this view. Retry the request, or use the navigation to
        continue elsewhere.
      </p>
      <Button type="button" variant="outline" onClick={reset}>
        Retry
      </Button>
    </Alert>
  );
}
