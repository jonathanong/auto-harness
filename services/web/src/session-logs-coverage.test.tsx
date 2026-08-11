// @vitest-environment happy-dom

import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import { describe, expect, it } from "vitest";

import { SessionLogs, type LogEntry } from "@auto-harness/ui";

const entry = (seq: number, stream: string, content: string, timestamp: string): LogEntry => ({
  seq,
  stream,
  content,
  timestamp,
});

describe("SessionLogs", () => {
  it("renders the default empty state and a custom empty message", () => {
    expect(renderToStaticMarkup(<SessionLogs items={[]} />)).toContain("No logs yet.");
    expect(
      renderToStaticMarkup(<SessionLogs items={[]} emptyMessage="Waiting for output" />),
    ).toContain('data-pw="session-logs-empty"');
    expect(
      renderToStaticMarkup(<SessionLogs items={[]} emptyMessage="Waiting for output" />),
    ).toContain("Waiting for output");
  });

  it("sorts entries by sequence and styles stderr separately", () => {
    const html = renderToStaticMarkup(
      <SessionLogs
        items={[
          entry(2, "stdout", "second", "12:02"),
          entry(1, "stderr", "first\nline", "12:01"),
          entry(3, "stdout", "third", "12:03"),
        ]}
      />,
    );
    expect(html).toContain('data-pw="session-logs"');
    expect(html.indexOf("first")).toBeLessThan(html.indexOf("second"));
    expect(html.indexOf("second")).toBeLessThan(html.indexOf("third"));
    expect(html).toContain("text-red-700");
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("first\nline");
  });
});
