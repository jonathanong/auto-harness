import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drainInputs,
  inputEnvName,
  runActionWithEnv,
  serve,
} from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

describe("dispatch action INPUT_* env var naming", () => {
  it("computes the canonical hyphen-preserving env var name for a hyphenated input", () => {
    expect(inputEnvName("queue-ttl-seconds")).toBe("INPUT_QUEUE-TTL-SECONDS");
  });

  it("reads a hyphenated input from its canonical hyphen-preserving env var, matching the real runner", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runActionWithEnv({
      "INPUT_API-KEY": "test-key",
      INPUT_OPERATION: "dispatch",
      INPUT_PROMPT: "review",
      "INPUT_QUEUE-TTL-SECONDS": "3600",
      "INPUT_REPOSITORY-ID": "repo/one",
      "INPUT_SERVER-URL": server.origin,
      INPUT_TARGET: '{"providerId":"provider-1"}',
      INPUT_TIMEOUT: "300",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({ queueTtlSeconds: 3600 });
  });

  it("does not read a hyphenated input from the old underscore-replaced env var name", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runActionWithEnv({
      "INPUT_API-KEY": "test-key",
      INPUT_OPERATION: "dispatch",
      INPUT_PROMPT: "review",
      // Old, wrong convention: hyphens replaced with underscores. Must be ignored.
      INPUT_QUEUE_TTL_SECONDS: "3600",
      "INPUT_REPOSITORY-ID": "repo/one",
      "INPUT_SERVER-URL": server.origin,
      INPUT_TARGET: '{"providerId":"provider-1"}',
      INPUT_TIMEOUT: "300",
    });

    expect(result.code).toBe(0);
    const body = JSON.parse(server.requests[0]!.body);
    expect(body).not.toHaveProperty("queueTtlSeconds");
  });

  it("fails closed when a required hyphenated input is only set under the old underscore-replaced name", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runActionWithEnv({
      ...Object.fromEntries(
        Object.entries(drainInputs(server.origin, "get-drain")).map(([name, value]) => [
          inputEnvName(name),
          value,
        ]),
      ),
      "INPUT_API-KEY": "",
      // Old, wrong convention for a required input: must not satisfy the requirement.
      INPUT_API_KEY: "test-key",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/Input required and not supplied: api-key/);
    expect(server.requests).toHaveLength(0);
  });
});
