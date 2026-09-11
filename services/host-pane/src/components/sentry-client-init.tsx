"use client";

import { useEffect } from "react";

export function SentryClientInit({ dsn }: { dsn: string }) {
  useEffect(() => {
    void import("../lib/sentry-client.ts").then((mod) => {
      mod.initBrowserSentry(dsn);
    });
  }, [dsn]);
  return null;
}
