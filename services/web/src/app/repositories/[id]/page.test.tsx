import { afterEach, describe, expect, it } from "vitest";

import { renderPage, stubApi } from "../../route-test-helpers.tsx";
import RepositoryDetailPage from "./page.tsx";

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

const baseApi = {
  "/api/v1/repositories/repo-a": {
    id: "repo-a",
    name: "Repo A",
    url: "https://example.test/repo-a",
    admissionState: "active",
  },
  "/api/v1/worktrees": { items: [] },
  "/api/v1/sessions?limit=100": { items: [] },
  "/api/v1/host-inventories": { items: [] },
  "/api/v1/providers": { items: [] },
  "/api/v1/provider-accounts": { items: [] },
  "/api/v1/commands": { items: [] },
};

describe("repository detail route", () => {
  it("hides admission controls from roles without repository operation capability", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      ...baseApi,
      "/api/v1/auth/me": { username: "author", role: "author", kind: "user" },
    });

    const html = await renderPage(
      RepositoryDetailPage({
        params: Promise.resolve({ id: "repo-a" }),
        searchParams: Promise.resolve({ tab: "settings" }),
      }),
    );

    expect(html).not.toContain('data-pw="repository-admission"');
    expect(html).not.toContain('data-pw="repository-pause"');
  });

  it("shows admission controls to an operator", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      ...baseApi,
      "/api/v1/auth/me": { username: "operator", role: "operator", kind: "user" },
    });

    const html = await renderPage(
      RepositoryDetailPage({
        params: Promise.resolve({ id: "repo-a" }),
        searchParams: Promise.resolve({ tab: "settings" }),
      }),
    );

    expect(html).toContain('data-pw="repository-admission"');
  });
});
