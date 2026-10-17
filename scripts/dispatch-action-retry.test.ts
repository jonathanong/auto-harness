import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { retryDelayMs } from "../actions/dispatch/src/retry.ts";
import {
  closeDispatchActionServers,
  drain,
  drainInputs,
  inputEnvName,
  runAction,
  runActionWithEnv,
  serve,
} from "./test-helpers/dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

const session = {
  created: true,
  concurrencyId: "github-42",
  id: "session-1",
  target: { providerId: "codex" },
  url: "https://example.test/sessions/session-1",
};

const dispatchInputs = (origin: string) => ({
  ...drainInputs(origin, "dispatch"),
  prompt: "review",
  target: '{"providerId":"codex"}',
  timeout: "300",
});

describe("dispatch action transient-failure retry", () => {
  it("retries a dispatch once after a 503 and succeeds", async () => {
    const server = await serve((request) =>
      server.requests.indexOf(request) === 0
        ? { body: { error: { message: "warming up" } }, status: 503 }
        : { body: session },
    );

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1]?.body).toBe(server.requests[0]?.body);
    expect(result.output["session-id"]).toBe("session-1");
  });

  it("retries a resume once after a dropped connection and succeeds", async () => {
    const server = await serve((request) =>
      server.requests.indexOf(request) === 0
        ? { body: null, destroy: true }
        : { body: { ...session, created: false } },
    );

    const result = await runAction({
      "api-key": "test-key",
      operation: "resume",
      "server-url": server.origin,
      "session-id": "session-1",
    });

    expect(result.code).toBe(0);
    expect(server.requests).toHaveLength(2);
    expect(result.output.created).toBe("false");
  });

  it("honors Retry-After before the retry", async () => {
    const started: number[] = [];
    const server = await serve(() => {
      started.push(Date.now());
      return started.length === 1
        ? { body: {}, headers: { "retry-after": "1" }, status: 429 }
        : { body: session };
    });

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(0);
    expect(started).toHaveLength(2);
    expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(950);
  });

  it.each([400, 401, 404, 409])("does not retry an HTTP %s", async (status) => {
    const server = await serve(() => ({ body: { error: { message: "nope" } }, status }));

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(1);
  });

  it("fails after the second attempt and reports the server message", async () => {
    const server = await serve(() => ({
      body: { error: { message: "database\n::warning::unavailable" } },
      status: 502,
    }));

    const result = await runAction(dispatchInputs(server.origin));

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(2);
    expect(result.stderr).toContain(
      "::error::Auto Harness returned 502: database%0A::warning::unavailable",
    );
  });

  it("does not retry drain operations", async () => {
    const server = await serve(() => ({ body: drain("succeeded"), status: 503 }));

    const result = await runAction({
      ...drainInputs(server.origin, "get-drain"),
      "session-drain-id": "drain-1",
    });

    expect(result.code).toBe(1);
    expect(server.requests).toHaveLength(1);
  });
});

describe("dispatch action retry delay", () => {
  it.each([
    [undefined, 500],
    ["", 500],
    ["2", 2_000],
    [" 0 ", 0],
    ["soon", 500],
    ["3600", 60_000],
    ["Thu, 01 Jan 1970 00:00:03 GMT", 2_000],
    ["Thu, 01 Jan 1970 00:00:00 GMT", 0],
  ])("maps Retry-After %j to %i ms", (retryAfter, expected) => {
    expect(retryDelayMs(retryAfter, 1_000)).toBe(expected);
  });
});

describe("dispatch action step summary", () => {
  it("writes a step summary and notice for a dispatched session", async () => {
    const server = await serve(() => ({ body: session }));
    const directory = await mkdtemp(join(tmpdir(), "auto-harness-dispatch-summary-"));
    const summary = join(directory, "summary.md");

    const result = await runActionWithEnv({
      ...Object.fromEntries(
        Object.entries(dispatchInputs(server.origin)).map(([name, value]) => [
          inputEnvName(name),
          value,
        ]),
      ),
      GITHUB_STEP_SUMMARY: summary,
    });
    const text = await readFile(summary, "utf8");
    await rm(directory, { force: true, recursive: true });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "::notice title=Auto Harness::Dispatched session session-1: https://example.test/sessions/session-1",
    );
    expect(text).toContain("### Dispatched Auto Harness session");
    expect(text).toContain("- Session: [`session-1`](https://example.test/sessions/session-1)");
    expect(text).toContain("- Created: yes");
    expect(text).toContain('- Provider route: `{"providerId":"codex"}`');
    expect(text).toContain("- Concurrency ID: `github-42`");
  });

  it("neutralizes backticks and newlines and omits absent fields", async () => {
    const server = await serve(() => ({
      body: { created: false, id: "a`b", url: "https://example.test/s" },
    }));
    const directory = await mkdtemp(join(tmpdir(), "auto-harness-dispatch-summary-"));
    const summary = join(directory, "summary.md");

    const result = await runActionWithEnv({
      [inputEnvName("api-key")]: "test-key",
      [inputEnvName("operation")]: "resume",
      [inputEnvName("server-url")]: server.origin,
      [inputEnvName("session-id")]: "session-1",
      GITHUB_STEP_SUMMARY: summary,
    });
    const text = await readFile(summary, "utf8");
    await rm(directory, { force: true, recursive: true });

    expect(result.code).toBe(0);
    expect(text).toContain("### Resumed Auto Harness session");
    expect(text).toContain("- Session: [`a'b`](https://example.test/s)");
    expect(text).toContain("- Created: no (existing session)");
    expect(text).not.toContain("Provider route");
    expect(text).not.toContain("Concurrency ID");
  });
});
