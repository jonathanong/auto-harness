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
            repositoryId: "repo/a",
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
            priority: 42,
            requiredLabels: ["codex", "gpu"],
            concurrencyId: "group",
          },
          {
            id: "embedded-name",
            status: "queued",
            repositoryId: "repo-embedded",
            repositoryName: "Embedded repository",
          },
          { id: "linked-id", status: "queued", repositoryId: "repo-id" },
        ]}
        repositoryNames={{ "repo/a": "Harness" }}
        repositoryHrefBase="/repositories"
      />,
    );
    expect(row).toContain('href="/sessions/a%2Fb"');
    expect(row).toContain('href="/repositories/repo%2Fa"');
    expect(row).toContain("Harness");
    expect(row).toContain("Embedded repository");
    expect(row).toContain('href="/repositories/repo-id"');
    expect(row).toContain("host");
    expect(row).toContain("+2 fallbacks");
    expect(row).toContain("target 1: account / command / route-host");
    expect(row).toContain("Prompt");
    expect(row).toContain('data-pw="session-priority-a/b">42');
    expect(row).toContain('data-pw="session-labels-a/b"');
    expect(row).toContain("codex");
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
            repositoryId: "repo-raw",
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
    expect(partial).toContain('data-pw="session-repository-partial">repo-raw');
    expect(partial).toContain('data-pw="session-repository-null-route">—');
    expect(partial).toContain("CLI / — / —");
    expect(render(<SessionsTable items={[]} emptyMessage="Nothing here" />)).toContain(
      "Nothing here",
    );
    expect(render(<SessionsTable items={[{ id: "dash", status: "unknown" }]} />)).toContain("—");

    const priorityDescending = render(
      <SessionsTable
        items={[]}
        sort="priority_desc"
        prioritySortHref="/sessions?sort=priority_asc"
      />,
    );
    expect(priorityDescending).toContain('aria-sort="descending"');
    expect(priorityDescending).toContain('href="/sessions?sort=priority_asc"');
    expect(priorityDescending).toContain('aria-label="Sort by priority, low to high"');
    expect(priorityDescending).toContain('data-pw="session-sort-priority"');
    expect(priorityDescending).toContain("↓");

    const priorityAscending = render(
      <SessionsTable
        items={[]}
        sort="priority_asc"
        prioritySortHref="/sessions?sort=priority_desc"
      />,
    );
    expect(priorityAscending).toContain('aria-sort="ascending"');
    expect(priorityAscending).toContain('aria-label="Sort by priority, high to low"');
    expect(priorityAscending).toContain("↑");

    const latest = render(
      <SessionsTable items={[]} sort="latest" prioritySortHref="/sessions?sort=priority_desc" />,
    );
    expect(latest).not.toContain("aria-sort");
    expect(latest).toContain("↕");

    const searchable = [
      {
        id: "searchable",
        status: "queued",
        prompt: "Deploy the service",
        concurrencyId: "release",
        targetLabel: null,
        targetLabels: ["primary", "backup"],
        requiredLabels: ["gpu"],
      },
      { id: "without-labels", status: "queued", prompt: null },
    ];
    expect(render(<SessionsTable items={searchable} search="  BACKUP  " />)).toContain(
      'data-pw="session-row-searchable"',
    );
    expect(render(<SessionsTable items={searchable} search="missing" />)).not.toContain(
      'data-pw="session-row-searchable"',
    );
    expect(render(<SessionsTable items={searchable} search="gpu" />)).toContain(
      'data-pw="session-row-searchable"',
    );
    expect(
      render(
        <SessionsTable
          items={[{ id: "repo-search", status: "queued", repositoryId: "repo-1" }]}
          repositoryNames={{ "repo-1": "Auto Harness" }}
          search="harness"
        />,
      ),
    ).toContain('data-pw="session-row-repo-search"');
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
