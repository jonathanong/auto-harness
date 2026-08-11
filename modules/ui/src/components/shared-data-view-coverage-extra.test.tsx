import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SessionsTable } from "./sessions-table.tsx";
import { Tabs } from "./tabs.tsx";

function render(node: React.ReactNode) {
  return renderToStaticMarkup(node);
}

describe("shared sessions table and tabs", () => {
  it("renders populated and empty sessions tables across route and link options", () => {
    const row = render(
      <SessionsTable
        showHost
        hrefBase="/sessions"
        items={[
          {
            id: "a/b",
            status: "running",
            hostId: "host",
            targetLabels: ["primary", "backup", "tertiary"],
            fallbacks: [{ providerId: "p" }],
            resolvedRoute: {
              targetIndex: 0,
              providerAccountId: "account",
              commandId: "command",
              hostId: "route-host",
            },
            queueExpiresAt: "later",
            prompt: "Prompt",
            source: "api",
            concurrencyId: "group",
          },
        ]}
      />,
    );
    expect(row).toContain('href="/sessions/a%2Fb"');
    expect(row).toContain("host");
    expect(row).toContain("+2 fallbacks");
    expect(row).toContain("target 1: account / command / route-host");
    expect(row).toContain("Prompt");
    const fallback = render(
      <SessionsTable
        items={[
          {
            id: "plain",
            status: "queued",
            target: { providerId: "p" },
            fallbacks: [{ commandId: "c" }],
          },
        ]}
      />,
    );
    expect(fallback).toContain("provider:p");
    expect(fallback).toContain("+1 fallback");
    expect(fallback).not.toContain('data-pw="session-link-plain"');
    expect(
      render(
        <SessionsTable items={[{ id: "command", status: "queued", target: { commandId: "c" } }]} />,
      ),
    ).toContain("command:c");
    const partial = render(
      <SessionsTable
        showHost
        items={[
          {
            id: "partial",
            status: "queued",
            hostId: null,
            target: {},
            targetLabels: ["primary", "backup"],
            fallbacks: null,
            resolvedRoute: { providerAccountId: "a", commandId: "route-c" },
          },
          { id: "cli-route", status: "queued", resolvedRoute: {} },
          { id: "null-route", status: "queued", target: {}, targetLabels: [] },
        ]}
      />,
    );
    expect(partial).toContain("a / route-c / —");
    expect(partial).toContain("CLI / — / —");
    expect(render(<SessionsTable items={[]} emptyMessage="Nothing here" />)).toContain(
      "Nothing here",
    );
    expect(render(<SessionsTable items={[{ id: "dash", status: "unknown" }]} />)).toContain("—");
  });

  it("links valid, fallback, and empty tab selections to their expected routes", () => {
    const tabs = [
      { key: "overview", label: "Overview", content: "Overview body" },
      { key: "runs", label: "Runs", content: "Runs body" },
    ];
    const active = render(<Tabs tabs={tabs} active="runs" basePath="/repo" pw="repo-tabs" />);
    expect(active).toContain('data-pw="tab-overview"');
    expect(active).toContain('href="/repo"');
    expect(active).toContain('href="/repo?tab=runs"');
    expect(active).toContain("Runs body");
    expect(render(<Tabs tabs={tabs} active="missing" basePath="/repo" />)).toContain(
      "Overview body",
    );
    expect(render(<Tabs tabs={[]} active="missing" basePath="/repo" />)).toContain(
      'role="tablist"',
    );
  });
});
