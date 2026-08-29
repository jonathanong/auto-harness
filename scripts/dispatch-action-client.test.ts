import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drainInputs,
  runAction,
  serve,
} from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

describe("dispatch action bundled client", () => {
  it("resolves provider and fallback command names before dispatch", async () => {
    const server = await serve((request) => {
      if (request.url === "/api/v1/providers") {
        return { body: { items: [{ id: "provider-1", name: "codex" }] } };
      }
      if (request.url === "/api/v1/commands") {
        return { body: { items: [{ id: "command-1", name: "review" }] } };
      }
      return {
        body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
      };
    });

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      fallbacks: '[{"commandName":"review"}]',
      prompt: "review",
      "server-url": `${server.origin}/api/v1/`,
      target: '{"providerName":"codex"}',
      timeout: "300",
    });

    expect(result.code).toBe(0);
    expect(server.requests.map(({ method, url }) => ({ method, url }))).toEqual([
      { method: "GET", url: "/api/v1/providers" },
      { method: "GET", url: "/api/v1/commands" },
      { method: "POST", url: "/api/v1/sessions" },
    ]);
    expect(JSON.parse(server.requests[2]!.body)).toMatchObject({
      fallbacks: [{ commandId: "command-1" }],
      target: { providerId: "provider-1" },
    });
  });

  it("makes no catalog requests when targets already use IDs", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      fallbacks: '[{"commandId":"command-1"}]',
      prompt: "review",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({ method: "POST", url: "/api/v1/sessions" });
  });

  it.each([
    ["unknown", [], /no provider named "codex"/],
    [
      "ambiguous",
      [
        { id: "secret-provider-1", name: "codex" },
        { id: "secret-provider-2", name: "codex" },
      ],
      /ambiguous provider name "codex": 2 providers share this name/,
    ],
  ])(
    "fails closed for an %s provider name without leaking catalog IDs",
    async (_name, items, error) => {
      const server = await serve(() => ({ body: { items } }));

      const result = await runAction({
        ...drainInputs(server.origin, "dispatch"),
        prompt: "review",
        target: '{"providerName":"codex"}',
        timeout: "300",
      });

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(error);
      expect(result.stderr).not.toContain("secret-provider");
      expect(server.requests).toHaveLength(1);
    },
  );

  it("applies the Action request timeout to catalog resolution", async () => {
    const server = await serve(() => ({ body: { items: [] }, bodyDelayMs: 300 }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      "request-timeout-seconds": "0.1",
      target: '{"providerName":"codex"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Timed out waiting for Auto Harness request/);
    expect(server.requests).toHaveLength(1);
  });

  it.each([
    [500, {}, /Auto Harness returned 500/],
    [200, null, /Auto Harness returned a malformed session response/],
  ])("preserves dispatch failure wording for an HTTP %s response", async (status, body, error) => {
    const server = await serve(() => ({ body, status }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(error);
  });

  it("escapes untrusted resolution errors before writing a workflow command", async () => {
    const server = await serve(() => ({ body: { items: [] } }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      target: '{"providerName":"codex\\n::warning::100% owned"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('codex%0A::warning::100%25 owned"');
    expect(result.stderr).not.toContain("\n::warning::");
  });
});
