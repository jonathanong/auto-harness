/* eslint-disable max-lines -- host route states are covered through one shared fixture. */
import { afterEach, describe, expect, it } from "vitest";

import { jsonResponse, renderPage, stubApi } from "../../route-test-helpers.tsx";
import HostDetailPage from "./page.tsx";

const catalogOk = {
  "/api/v1/hosts/host-a/inventory": {
    setupScript: "source ~/.zshrc",
    repositories: [{ id: "repo-a", path: "/repos/a", worktrees: [] }],
    providerAccounts: [],
  },
  "/api/v1/hosts": { items: [{ hostId: "host-a", online: true }] },
  "/api/v1/repositories": { items: [{ id: "repo-a", name: "Repo A" }] },
  "/api/v1/worktrees?hostId=host-a": { items: [] },
  "/api/v1/providers": { items: [] },
  "/api/v1/provider-accounts": { items: [] },
  "/api/v1/commands": { items: [] },
};

const originalAuthMode = process.env.HARNESS_AUTH_MODE;

afterEach(() => {
  if (originalAuthMode === undefined) delete process.env.HARNESS_AUTH_MODE;
  else process.env.HARNESS_AUTH_MODE = originalAuthMode;
});

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

  it("shows repository environment readiness and missing variable names", async () => {
    stubApi({
      ...catalogOk,
      "/api/v1/hosts": {
        items: [
          {
            hostId: "host-a",
            online: true,
            environmentReadiness: {
              "repo-a": { required: ["TOKEN"], missing: ["TOKEN"], ready: false },
            },
          },
        ],
      },
    });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="host-environment-readiness-repo-a"');
    expect(html).toContain("Repo A:");
    expect(html).toContain("Missing TOKEN");
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
    stubApi({ ...catalogOk, "/api/v1/worktrees?hostId=host-a": jsonResponse({}, 500) });
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

  it("never fabricates an empty inventory when the agent is known but the fetch really failed", async () => {
    // A fabricated empty inventory could be submitted on the next save and wipe real config.
    stubApi({
      "/api/v1/hosts/host-a/inventory": jsonResponse({}, 500),
      "/api/v1/hosts": { items: [{ hostId: "host-a", online: true }] },
    });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="host-detail-inventory-error"');
    expect(html).toContain("Could not load host host-a&#x27;s inventory");
    expect(html).not.toContain('data-pw="host-detail-tabs"');
    expect(html).not.toContain('data-pw="form-add-local-repo"');
  });

  it("hides inventory and provider-account write chrome for an operator", async () => {
    process.env.HARNESS_AUTH_MODE = "required";
    stubApi({
      ...catalogOk,
      "/api/v1/auth/me": { username: "op", role: "operator", kind: "user" },
    });
    const repos = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({ tab: "repositories" }),
      }),
    );
    expect(repos).toContain('data-pw="host-repositories-section"');
    expect(repos).not.toContain('data-pw="form-add-local-repo"');
    const advanced = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({ tab: "advanced" }),
      }),
    );
    expect(advanced).not.toContain('data-pw="form-host-config-json"');
    expect(advanced).toContain("repo-a");
  });

  it("renders the Advanced tab with the raw inventory JSON editor", async () => {
    stubApi(catalogOk);
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "host-a" }),
        searchParams: Promise.resolve({ tab: "advanced" }),
      }),
    );
    expect(html).toContain('data-pw="form-host-config-json"');
    expect(html).toContain('data-pw="host-config-json"');
    expect(html).toContain("source ~/.zshrc");
  });

  it("decodes a percent-encoded host id before lookup and display", async () => {
    stubApi({
      "/api/v1/hosts/admin:admin/inventory": {
        repositories: [],
        providerAccounts: [],
      },
      "/api/v1/hosts": { items: [{ hostId: "admin:admin", online: true }] },
      "/api/v1/repositories": { items: [] },
      "/api/v1/worktrees?hostId=admin%3Aadmin": { items: [] },
      "/api/v1/providers": { items: [] },
      "/api/v1/provider-accounts": { items: [] },
      "/api/v1/commands": { items: [] },
    });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "admin%3Aadmin" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="page-host-detail"');
    expect(html).toContain(">admin:admin<");
    expect(html).not.toContain('data-pw="page-host-detail-not-found"');
    expect(html).not.toContain("No host");
  });

  it("shows a decoded host id in the not-found empty state", async () => {
    stubApi({
      "/api/v1/hosts/admin:admin/inventory": jsonResponse({}, 404),
      "/api/v1/hosts": { items: [] },
    });
    const html = await renderPage(
      HostDetailPage({
        params: Promise.resolve({ hostId: "admin%3Aadmin" }),
        searchParams: Promise.resolve({}),
      }),
    );
    expect(html).toContain('data-pw="page-host-detail-not-found"');
    expect(html).toContain("No host");
    expect(html).toContain("admin:admin");
    expect(html).not.toContain("%3A");
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
