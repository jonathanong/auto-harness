import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drainInputs,
  runAction,
  serve,
} from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

describe("dispatch action queue-ttl-seconds and priority inputs", () => {
  it("passes queue-ttl-seconds and priority through to the dispatch body", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      "queue-ttl-seconds": "3600",
      priority: "10",
      prompt: "review",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
      queueTtlSeconds: 3600,
      priority: 10,
    });
  });

  it("omits queue-ttl-seconds and priority from the dispatch body when not supplied", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(0);
    const body = JSON.parse(server.requests[0]!.body);
    expect(body).not.toHaveProperty("queueTtlSeconds");
    expect(body).not.toHaveProperty("priority");
  });

  it.each([
    ["above the 2592000 second bound", "2592001"],
    ["fractional", "1.5"],
  ])("rejects a %s queue-ttl-seconds before making a request", async (_name, value) => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      "queue-ttl-seconds": value,
      prompt: "review",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(
      /queue-ttl-seconds must be a finite positive integer no greater than 2592000/,
    );
    expect(server.requests).toHaveLength(0);
  });

  it.each([
    ["outside the -10000 to 10000 bound", "-10001"],
    ["fractional", "0.5"],
  ])("rejects a %s dispatch priority before making a request", async (_name, value) => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      priority: value,
      prompt: "review",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/priority must be a finite integer between -10000 and 10000/);
    expect(server.requests).toHaveLength(0);
  });
});
