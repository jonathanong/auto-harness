"use client";

import { useEffect } from "react";

export function SentryClientInit({ dsn, plane }: { dsn: string; plane: "web" | "host-pane" }) {
  useEffect(() => {
    void import("../lib/sentry-client.ts").then((mod) => {
      mod.initBrowserSentry(dsn, plane);
    });
  }, [dsn, plane]);
  return null;
}
