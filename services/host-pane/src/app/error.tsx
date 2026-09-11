"use client";

import { useEffect } from "react";
import { Alert, Button } from "@auto-harness/ui";

import { reportClientError } from "../lib/sentry-client.ts";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    reportClientError(error);
  }, [error]);
  return (
    <Alert variant="danger" role="alert" className="space-y-3 rounded-lg p-5">
      <h2 className="text-lg font-semibold" tabIndex={-1} autoFocus>
        This page could not be loaded
      </h2>
      <p className="text-sm">
        The host pane could not render this view. Retry the request, or use the control plane.
      </p>
      <Button type="button" variant="outline" onClick={reset}>
        Retry
      </Button>
    </Alert>
  );
}
