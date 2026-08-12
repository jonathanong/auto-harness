import { describe, expect, it } from "vitest";

import NewSessionPage from "./sessions/new/page.tsx";
import { renderPage, stubApi } from "./route-test-helpers.tsx";

describe("new session route", () => {
  const blankSearchParams = { searchParams: Promise.resolve({}) };

  it("offers sorted unique labels from online worktrees only", async () => {
    stubApi({
      "/api/v1/session-targets": {
        items: [{ kind: "command", id: "command-1", label: "Run" }],
      },
      "/api/v1/repositories": {
        items: [
          { id: "repo-z", name: "zeta" },
          { id: "repo-a", name: "alpha" },
        ],
      },
      "/api/v1/worktrees": {
        items: [
          { online: true, labels: ["gpu", "", "codex", "gpu"] },
          { online: false, labels: ["offline-only"] },
          { online: true },
        ],
      },
    });
    const html = await renderPage(NewSessionPage(blankSearchParams));
    expect(html).toContain('data-pw="create-session-label-codex"');
    expect(html).toContain('data-pw="create-session-label-gpu"');
    expect(html).not.toContain("offline-only");
    expect(html.indexOf("create-session-label-codex")).toBeLessThan(
      html.indexOf("create-session-label-gpu"),
    );
    expect(html.indexOf(">alpha</option>")).toBeLessThan(html.indexOf(">zeta</option>"));
  });

  it("keeps the form useful and reports each option endpoint failure", async () => {
    stubApi({
      "/api/v1/session-targets": "__throw_string__",
      "/api/v1/repositories": "__throw_string__",
      "/api/v1/worktrees": "__throw_string__",
    });
    let html = await renderPage(NewSessionPage(blankSearchParams));
    expect(html).toContain("targets: offline; repositories: offline; labels: offline");
    expect(html).toContain('data-pw="create-session-labels-empty"');

    stubApi({
      "/api/v1/session-targets": {},
      "/api/v1/repositories": {},
      "/api/v1/worktrees": {},
    });
    html = await renderPage(NewSessionPage(blankSearchParams));
    expect(html).toContain('data-pw="form-create-session"');
  });

  it("loads a bounded clone source and renders only replayable inputs", async () => {
    stubApi({
      "/api/v1/session-targets": {
        items: [{ kind: "provider", id: "provider", label: "Provider" }],
      },
      "/api/v1/repositories": { items: [] },
      "/api/v1/worktrees": { items: [{ online: true, labels: ["online"] }] },
      "/api/v1/sessions/source%2Fsession": {
        repositoryId: "source-repository",
        prompt: "secret-looking prompt stays in the response body, not the URL",
        target: { providerId: "provider" },
        fallbacks: [{ commandId: "missing-command" }],
        queueTtlSeconds: 120,
        timeout: 30,
        priority: 50,
        requiredLabels: ["source-label"],
        ref: "source/ref",
        concurrencyId: "excluded-concurrency",
        cliResumeRef: "excluded-resume",
      },
    });
    const html = await renderPage(
      NewSessionPage({ searchParams: Promise.resolve({ cloneFrom: "source/session" }) }),
    );
    expect(html).toContain('data-pw="session-clone-source"');
    expect(html).toContain("Nothing is created until you submit this form");
    expect(html).toContain('value="source-repository"');
    expect(html).toContain("secret-looking prompt stays in the response body, not the URL");
    expect(html).toContain('value="provider:provider" selected=""');
    expect(html).toContain('value="command:missing-command" selected=""');
    expect(html).toContain("Unavailable command missing-command (unavailable)");
    expect(html).toContain('checked="" value="source-label"');
    expect(html).toContain('value="50"');
    expect(html).toContain('value="source/ref"');
    expect(html).not.toContain("excluded-concurrency");
    expect(html).not.toContain("excluded-resume");
  });

  it("does not fetch an invalid id and keeps a failed clone source generic", async () => {
    let fetch = stubApi({
      "/api/v1/session-targets": {},
      "/api/v1/repositories": {},
      "/api/v1/worktrees": {},
    });
    let html = await renderPage(
      NewSessionPage({ searchParams: Promise.resolve({ cloneFrom: ["one", "two"] }) }),
    );
    expect(html).toContain("clone source: invalid id");
    expect(fetch).toHaveBeenCalledTimes(3);

    fetch = stubApi({
      "/api/v1/session-targets": {},
      "/api/v1/repositories": {},
      "/api/v1/worktrees": {},
      "/api/v1/sessions/missing": new Error("private detail"),
    });
    html = await renderPage(
      NewSessionPage({ searchParams: Promise.resolve({ cloneFrom: "missing" }) }),
    );
    expect(html).toContain("clone source: session could not be loaded");
    expect(html).not.toContain("private detail");
    expect(fetch).toHaveBeenCalledTimes(4);

    stubApi({
      "/api/v1/session-targets": {},
      "/api/v1/repositories": {},
      "/api/v1/worktrees": {},
      "/api/v1/sessions/incomplete": { repositoryId: "repo", target: { commandId: "cmd" } },
    });
    html = await renderPage(
      NewSessionPage({ searchParams: Promise.resolve({ cloneFrom: "incomplete" }) }),
    );
    expect(html).toContain("clone source: session inputs are unavailable");
  });
});
