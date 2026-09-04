import { afterEach, describe, expect, it } from "vitest";

import { closeDispatchActionServers, runAction, serve } from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

const resumeInputs = (origin: string, overrides: Record<string, string> = {}) => ({
  "api-key": "test-key",
  operation: "resume",
  "server-url": origin,
  "session-id": "session-1",
  ...overrides,
});

describe("dispatch action resume operation", () => {
  it("resumes a session with only the required session-id and no repository-id", async () => {
    const server = await serve(() => ({
      body: { created: false, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runAction(resumeInputs(server.origin));

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "POST",
      url: "/api/v1/sessions/session-1/resume",
    });
    expect(server.requests[0]!.body).toBe("{}");
    expect(result.output).toMatchObject({
      "session-id": "session-1",
      "session-url": "https://example.test/sessions/session-1",
      created: "false",
    });
    expect(result.stdout).toContain("Resumed Auto Harness session session-1");
  });

  it("passes prompt, concurrency-id, timeout, and priority overrides in the resume body", async () => {
    const server = await serve(() => ({
      body: { created: false, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runAction(
      resumeInputs(server.origin, {
        "concurrency-id": "github-42",
        prompt: "Continue: also fix the edge case",
        priority: "-5",
        timeout: "600",
      }),
    );

    expect(result.code).toBe(0);
    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      prompt: "Continue: also fix the edge case",
      concurrencyId: "github-42",
      timeout: 600,
      priority: -5,
    });
  });

  it("requires session-id and makes no request when it is missing", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction({
      "api-key": "test-key",
      operation: "resume",
      "server-url": server.origin,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Input required and not supplied: session-id/);
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ["outside the -10000 to 10000 bound", "10001"],
    ["fractional", "0.5"],
  ])("rejects a %s resume priority before making a request", async (_name, value) => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction(resumeInputs(server.origin, { priority: value }));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/priority must be a finite integer between -10000 and 10000/);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects a timeout above the 604800 second resume bound before making a request", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction(resumeInputs(server.origin, { timeout: "604801" }));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /timeout must be a finite positive number no greater than 604800/,
    );
    expect(server.requests).toHaveLength(0);
  });

  it("makes DRAINING resume failures directly actionable", async () => {
    const server = await serve(() => ({
      status: 409,
      body: {
        error: {
          code: "DRAINING",
          message: "principal session admission is draining",
          operationId: "drain-1",
          statusUrl: "/api/v1/repositories/repo%2Fone/session-drains/drain-1",
        },
      },
    }));

    const result = await runAction(resumeInputs(server.origin));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `drain drain-1: ${server.origin}/api/v1/repositories/repo%252Fone/session-drains/drain-1`,
    );
  });

  it("forwards an id-shaped target/fallbacks rebinding override untouched", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-2", url: "https://example.test/sessions/session-2" },
    }));

    const result = await runAction(
      resumeInputs(server.origin, {
        target: '{"commandId":"cmd-new"}',
        fallbacks: '[{"providerId":"prov-1"}]',
      }),
    );

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(JSON.parse(server.requests[0]!.body)).toEqual({
      target: { commandId: "cmd-new" },
      fallbacks: [{ providerId: "prov-1" }],
    });
  });

  it("resolves a commandName target via the catalog before resuming", async () => {
    const server = await serve((request) =>
      request.url?.startsWith("/api/v1/commands")
        ? { body: { items: [{ id: "cmd-new", name: "claude-print-auto" }] } }
        : {
            body: {
              created: true,
              id: "session-2",
              url: "https://example.test/sessions/session-2",
            },
          },
    );

    const result = await runAction(
      resumeInputs(server.origin, { target: '{"commandName":"claude-print-auto"}' }),
    );

    expect(result.code).toBe(0);
    const resumeRequest = server.requests.find((r) => r.url?.includes("/resume"));
    expect(JSON.parse(resumeRequest!.body)).toEqual({ target: { commandId: "cmd-new" } });
  });

  it("rejects fallbacks without target before making a request", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction(
      resumeInputs(server.origin, { fallbacks: '[{"commandId":"cmd-1"}]' }),
    );

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/fallbacks requires target/);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects a malformed successful resume response", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction(resumeInputs(server.origin));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/session without a valid id/);
    expect(result.output).toEqual({});
  });
});
