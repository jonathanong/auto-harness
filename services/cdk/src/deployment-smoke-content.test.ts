import { describe, expect, it, vi } from "vitest";

import {
  config,
  dependencies,
  HEALTHY_LOGIN_HTML,
} from "../test-helpers/deployment-test-helpers.ts";
import { smokeDeployment } from "./deployment-support.ts";

/**
 * Serve /health the usual `{"ok":true}` and /login whatever this deployment is pretending
 * to return, so each case isolates the page-content assertion from stack plumbing.
 */
function smokeWithLoginBody(body: string, status = 200) {
  const deps = dependencies([]);
  deps.fetch = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
    new URL(input as URL).pathname === "/health"
      ? new Response('{"ok":true}', { status: 200 })
      : new Response(body, { status }),
  );
  return { deps, run: async () => smokeDeployment(config(), deps) };
}

describe("smokeDeployment login page content", () => {
  it("accepts a login page that renders the form", async () => {
    const { deps, run } = smokeWithLoginBody(HEALTHY_LOGIN_HTML);
    await expect(run()).resolves.toBeUndefined();
    expect(deps.log).toHaveBeenCalledWith("Web health check passed: https://api.example.test");
  });

  // The 2026-09-16 outage in one assertion: every page returned 200 while the server-side
  // API fetch was rejected for want of the CloudFront ingress token, so the HTML arrived
  // structurally valid and completely empty. A status-only probe called that healthy.
  it("rejects HTTP 200 that renders no login form", async () => {
    const { run } = smokeWithLoginBody("<!DOCTYPE html><html><body></body></html>");
    await expect(run()).rejects.toThrow(
      /HTTP 200 without rendering the login form .*data-pw="page-login", data-pw="form-login"/u,
    );
  });

  // The page shell can render while the client subtree fails to server-render. Asserting
  // only the outer marker would pass a login page with no usable form in it.
  it("rejects a page shell whose form never server-rendered", async () => {
    const { run } = smokeWithLoginBody('<main data-pw="page-login"></main>');
    await expect(run()).rejects.toThrow(/missing data-pw="form-login"/u);
  });

  it("rejects a leaked Next control-flow digest and names it", async () => {
    const { run } = smokeWithLoginBody(
      `${HEALTHY_LOGIN_HTML}<div>NEXT_REDIRECT;replace;/login;307;</div>`,
    );
    await expect(run()).rejects.toThrow(
      "web health check leaked a Next control-flow digest: NEXT_REDIRECT",
    );
  });

  it("rejects a not-found fallback digest too, not just redirects", async () => {
    const { run } = smokeWithLoginBody(`${HEALTHY_LOGIN_HTML}NEXT_HTTP_ERROR_FALLBACK;404`);
    await expect(run()).rejects.toThrow(/digest: NEXT_HTTP_ERROR_FALLBACK/u);
  });

  // Next's own inline flight payload is `self.__next_f.push(...)`. A digest scan that
  // tripped on it would fail every healthy deploy, so pin that it does not.
  it("does not mistake Next's inline flight payload for a digest", async () => {
    const { run } = smokeWithLoginBody(
      `${HEALTHY_LOGIN_HTML}<script>self.__next_f.push([1,"data"])</script>`,
    );
    await expect(run()).resolves.toBeUndefined();
  });

  it("still reports a non-2xx login response before looking at content", async () => {
    const { run } = smokeWithLoginBody("", 503);
    await expect(run()).rejects.toThrow("web health check failed with HTTP 503");
  });

  // The login page must be terminal. Following redirects would hide the bounce loop that
  // sent every page, login included, back to /login.
  it("requests the login page without following redirects", async () => {
    const { deps, run } = smokeWithLoginBody(HEALTHY_LOGIN_HTML);
    await run();
    expect(deps.fetch).toHaveBeenCalledWith(new URL("https://api.example.test/login"), {
      redirect: "manual",
    });
  });
});
