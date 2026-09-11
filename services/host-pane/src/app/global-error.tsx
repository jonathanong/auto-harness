"use client";

import { useEffect } from "react";

import { reportClientError } from "../lib/sentry-client.ts";

export default function GlobalError({
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
    <html lang="en">
      <body>
        <h2>This page could not be loaded</h2>
        <button type="button" onClick={reset}>
          Retry
        </button>
      </body>
    </html>
  );
}
