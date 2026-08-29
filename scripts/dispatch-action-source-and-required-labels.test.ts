import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drainInputs,
  runAction,
  serve,
} from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

describe("dispatch action source and required-labels inputs", () => {
  it("passes source and required-labels through to the dispatch body", async () => {
    const server = await serve(() => ({
      body: { created: true, id: "session-1", url: "https://example.test/sessions/session-1" },
    }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      "required-labels": '["gpu","self-hosted"]',
      source: "webhook",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
      requiredLabels: ["gpu", "self-hosted"],
      source: "webhook",
    });
  });

  it("omits source and required-labels from the dispatch body when not supplied", async () => {
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
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("requiredLabels");
  });

  it("rejects an unrecognized source before making a request", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      source: "schedule",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/source must be api, ui, or webhook; received schedule/);
    expect(server.requests).toHaveLength(0);
  });

  it("rejects malformed required-labels JSON before making a request", async () => {
    const server = await serve(() => ({ body: {} }));

    const result = await runAction({
      ...drainInputs(server.origin, "dispatch"),
      prompt: "review",
      "required-labels": "not-json",
      target: '{"providerId":"provider-1"}',
      timeout: "300",
    });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/required-labels must be valid JSON/);
    expect(server.requests).toHaveLength(0);
  });
});
