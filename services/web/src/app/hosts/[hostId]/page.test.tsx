import { describe, expect, it } from "vitest";

import { jsonResponse, renderPage, stubApi } from "../../route-test-helpers.tsx";
import HostDetailPage from "./page.tsx";

const catalogOk = {
  "/api/v1/hosts/host-a/inventory": {
    repositories: [{ id: "repo-a", path: "/repos/a", worktrees: [] }],
    providerAccounts: [],
  },
  "/api/v1/hosts": { items: [{ hostId: "host-a", online: true }] },
  "/api/v1/repositories": { items: [{ id: "repo-a", name: "Repo A" }] },
  "/api/v1/worktrees": { items: [] },
  "/api/v1/providers": { items: [] },
  "/api/v1/provider-accounts": { items: [] },
  "/api/v1/commands": { items: [] },
};

describe("host detail route", () => {
  it("renders every section from a fully healthy backend", async () => {
    stubApi(catalogOk);
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="page-host-detail"');
    expect(html).not.toContain("-error");
  });

  it("shows a genuine not-found for a host with no inventory and no agent record", async () => {
    stubApi({
      "/api/v1/hosts/missing/inventory": jsonResponse({}, 404),
      "/api/v1/hosts": { items: [] },
    });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "missing" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="page-host-detail-not-found"');
    expect(html).toContain("No host");
    expect(html).not.toContain('data-pw="host-detail-lookup-error"');
  });

  it("distinguishes a real lookup failure from a genuine 404", async () => {
    stubApi({
      "/api/v1/hosts/broken/inventory": jsonResponse({}, 500),
      "/api/v1/hosts": jsonResponse({}, 503),
    });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "broken" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="host-detail-lookup-error"');
    expect(html).toContain("Could not load host broken");
    expect(html).not.toContain("No host");
  });

  it("surfaces a catalog failure without hiding the rest of the page", async () => {
    stubApi({ ...catalogOk, "/api/v1/repositories": jsonResponse({}, 503) });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({ tab: "repositories" }),
      }),
    );
    expect(html).toContain('data-pw="host-repositories-catalog-error"');
    expect(html).not.toContain('data-pw="form-add-local-repo"');
    expect(html).not.toContain('data-pw="host-detail-lookup-error"');
  });

  it("surfaces a live-worktree-status failure alongside the attached hierarchy", async () => {
    stubApi({ ...catalogOk, "/api/v1/worktrees": jsonResponse({}, 500) });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({ tab: "repositories" }),
      }),
    );
    expect(html).toContain('data-pw="host-repositories-worktree-status-error"');
    expect(html).toContain('data-pw="host-repositories-section"');
  });

  it("surfaces a provider-catalog failure in place of the attach form only", async () => {
    stubApi({ ...catalogOk, "/api/v1/provider-accounts": jsonResponse({}, 503) });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({ tab: "provider-accounts" }),
      }),
    );
    expect(html).toContain('data-pw="host-provider-accounts-catalog-error"');
    expect(html).not.toContain('data-pw="attach-provider-account-select"');
  });

  it("surfaces an agent-status failure on the Overview tab without hiding the page", async () => {
    stubApi({ ...catalogOk, "/api/v1/hosts": jsonResponse({}, 503) });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="host-detail-status-error"');
    expect(html).toContain('data-pw="page-host-detail"');
  });
});
