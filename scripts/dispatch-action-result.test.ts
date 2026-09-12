import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  runAction,
  serve,
} from "./test-helpers/dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

const resultInputs = (origin: string, overrides: Record<string, string> = {}) => ({
  "api-key": "test-key",
  operation: "get-result",
  "server-url": origin,
  "session-id": "session-1",
  ...overrides,
});

const session = (overrides: Record<string, unknown> = {}) => ({
  id: "session-1",
  url: "https://harness.test/sessions/session-1",
  status: "completed",
  ...overrides,
});

describe("dispatch action one-shot session result", () => {
  it("reads a terminal structured result once and exposes both JSON and scalar outputs", async () => {
    const server = await serve(() => ({
      body: session({
        result: {
          summary: "Changed parser\nand added coverage.",
          summarySource: "agent",
          summaryTruncated: true,
          branch: "fix/parser",
          filesChanged: ["src/parser.ts", "src/parser.test.ts"],
          filesChangedTruncated: true,
          pullRequestUrl: "https://github.com/example/repo/pull/1",
        },
      }),
    }));

    const result = await runAction(resultInputs(server.origin));

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(server.requests[0]).toMatchObject({
      method: "GET",
      url: "/api/v1/sessions/session-1",
    });
    expect(result.output).toMatchObject({
      "session-id": "session-1",
      "session-url": "https://harness.test/sessions/session-1",
      "result-url": `${server.origin}/api/v1/sessions/session-1`,
      "session-status": "completed",
      "session-terminal": "true",
      "result-summary": "Changed parser\nand added coverage.",
      "result-summary-truncated": "true",
      "result-summary-source": "agent",
      "result-branch": "fix/parser",
      "result-files-changed": '["src/parser.ts","src/parser.test.ts"]',
      "result-files-changed-truncated": "true",
      "result-pull-request-url": "https://github.com/example/repo/pull/1",
    });
    expect(JSON.parse(result.output["session-result"]!)).toEqual({
      summary: "Changed parser\nand added coverage.",
      summarySource: "agent",
      summaryTruncated: true,
      branch: "fix/parser",
      filesChanged: ["src/parser.ts", "src/parser.test.ts"],
      filesChangedTruncated: true,
      pullRequestUrl: "https://github.com/example/repo/pull/1",
    });
  });

  it("returns active sessions successfully with empty result outputs and no polling", async () => {
    const server = await serve(() => ({ body: session({ status: "running" }) }));

    const result = await runAction(resultInputs(server.origin));

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(1);
    expect(result.output).toMatchObject({
      "session-status": "running",
      "session-terminal": "false",
      "session-result": "",
      "result-summary": "",
      "result-summary-truncated": "",
      "result-summary-source": "",
      "result-branch": "",
      "result-files-changed": "",
      "result-files-changed-truncated": "",
      "result-pull-request-url": "",
    });
  });

  it.each(["failed", "cancelled", "timed_out"])(
    "returns a terminal %s session successfully so workflows can branch on it",
    async (status) => {
      const server = await serve(() => ({ body: session({ status }) }));

      const result = await runAction(resultInputs(server.origin));

      expect(result.code).toBe(0);
      expect(result.output).toMatchObject({
        "session-status": status,
        "session-terminal": "true",
        "session-result": "",
      });
    },
  );

  it("requires session-id before issuing a request", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction({
      "api-key": "test-key",
      operation: "get-result",
      "server-url": server.origin,
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Input required and not supplied: session-id/);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects a malformed result instead of exposing unvalidated output", async () => {
    const server = await serve(() => ({
      body: session({ result: { summary: "missing source" } }),
    }));

    const result = await runAction(resultInputs(server.origin));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/result without a valid summarySource/);
  });

  it("rejects an invalid summary truncation marker", async () => {
    const server = await serve(() => ({
      body: session({
        result: { summary: "done", summarySource: "agent", summaryTruncated: false },
      }),
    }));

    const result = await runAction(resultInputs(server.origin));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/invalid summaryTruncated/);
  });

  it("rejects an unknown session status instead of treating it as active", async () => {
    const server = await serve(() => ({ body: session({ status: "reticulating_splines" }) }));

    const result = await runAction(resultInputs(server.origin));

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/session without a valid status/);
  });

  it("adds a result URL to fire-and-forget dispatch responses", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://harness.test/sessions/session-1" },
    }));

    const result = await runAction({
      "api-key": "test-key",
      operation: "dispatch",
      "repository-id": "repo-1",
      "server-url": server.origin,
      prompt: "review",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(0);
    expect(result.output["result-url"]).toBe(`${server.origin}/api/v1/sessions/session-1`);
  });
});
