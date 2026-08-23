import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import CommandsPage from "./commands/page.tsx";
import ProvidersPage from "./providers/page.tsx";
import RepositoriesPage from "./repositories/page.tsx";
import { renderPage, stubApi } from "./route-test-helpers.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

describe("control catalog list capability gates", () => {
  it("hides command catalog write chrome for an operator", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "op", role: "operator", kind: "user" },
      "/api/v1/commands": { items: [] },
      "/api/v1/providers": { items: [] },
    });
    const html = await renderPage(CommandsPage());
    expect(html).toContain("No commands registered yet.");
    expect(html).not.toContain('data-pw="add-command-open"');
  });

  it("hides provider catalog write chrome for an operator", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "op", role: "operator", kind: "user" },
      "/api/v1/providers": { items: [] },
      "/api/v1/provider-accounts": { items: [] },
      "/api/v1/commands": { items: [] },
    });
    const html = await renderPage(ProvidersPage());
    expect(html).toContain("No providers registered yet.");
    expect(html).not.toContain('data-pw="add-provider-open"');
  });

  it("hides repository catalog and inventory write chrome for an operator", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      "/api/v1/auth/me": { username: "op", role: "operator", kind: "user" },
      "/api/v1/repositories": {},
      "/api/v1/hosts": {},
      "/api/v1/worktrees": {},
    });
    let html = await renderPage(RepositoriesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("No repositories configured");
    expect(html).not.toContain('data-pw="add-repo-open"');
    expect(html).not.toContain('data-pw="repositories-empty-add"');
    stubApi({
      "/api/v1/auth/me": { username: "op", role: "operator", kind: "user" },
      "/api/v1/repositories": {
        items: [{ id: "r-1", name: "harness", url: "/src/harness" }],
      },
      "/api/v1/hosts": { items: [{ hostId: "host-1" }] },
      "/api/v1/worktrees": { items: [] },
    });
    html = await renderPage(RepositoriesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-pw="page-repositories"');
    expect(html).not.toContain("Attach a repository to a host");
    expect(html).not.toContain('data-pw="add-repo-open"');
  });
});
