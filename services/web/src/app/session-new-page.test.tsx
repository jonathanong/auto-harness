import { describe, expect, it } from "vitest";

import NewSessionPage from "./sessions/new/page.tsx";
import { renderPage, stubApi } from "./route-test-helpers.tsx";

describe("new session route", () => {
  it("offers sorted unique labels from online worktrees only", async () => {
    stubApi({
      "/api/v1/session-targets": {
        items: [{ kind: "command", id: "command-1", label: "Run" }],
      },
      "/api/v1/worktrees": {
        items: [
          { online: true, labels: ["gpu", "", "codex", "gpu"] },
          { online: false, labels: ["offline-only"] },
          { online: true },
        ],
      },
    });
    const html = await renderPage(NewSessionPage());
    expect(html).toContain('data-pw="create-session-label-codex"');
    expect(html).toContain('data-pw="create-session-label-gpu"');
    expect(html).not.toContain("offline-only");
    expect(html.indexOf("create-session-label-codex")).toBeLessThan(
      html.indexOf("create-session-label-gpu"),
    );
  });

  it("keeps the form useful and reports each option endpoint failure", async () => {
    stubApi({
      "/api/v1/session-targets": "__throw_string__",
      "/api/v1/worktrees": "__throw_string__",
    });
    let html = await renderPage(NewSessionPage());
    expect(html).toContain("targets: offline; labels: offline");
    expect(html).toContain('data-pw="create-session-labels-empty"');

    stubApi({ "/api/v1/session-targets": {}, "/api/v1/worktrees": {} });
    html = await renderPage(NewSessionPage());
    expect(html).toContain('data-pw="form-create-session"');
  });
});
