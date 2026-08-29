import { afterEach, describe, expect, it } from "vitest";

import {
  closeDispatchActionServers,
  drainInputs,
  runAction,
  serve,
} from "./dispatch-action-test-helpers.ts";

afterEach(closeDispatchActionServers);

const createdSessionBody = {
  created: true,
  id: "session-1",
  url: "https://example.test/sessions/session-1",
};

const baseDispatchInputs = (origin: string) => ({
  ...drainInputs(origin, "dispatch"),
  prompt: "review",
  target: '{"providerId":"provider-1"}',
  timeout: "300",
});

describe("dispatch action source and required-labels inputs", () => {
  it("passes source and required-labels through to the dispatch body", async () => {
    const server = await serve(() => ({ body: createdSessionBody }));

    const result = await runAction({
      ...baseDispatchInputs(server.origin),
      "required-labels": '["gpu","self-hosted"]',
      source: "webhook",
    });

    expect(result.code).toBe(0);
    expect(JSON.parse(server.requests[0]!.body)).toMatchObject({
      requiredLabels: ["gpu", "self-hosted"],
      source: "webhook",
    });
  });

  it("omits source and required-labels from the dispatch body when not supplied", async () => {
    const server = await serve(() => ({ body: createdSessionBody }));

    const result = await runAction(baseDispatchInputs(server.origin));

    expect(result.code).toBe(0);
    const body = JSON.parse(server.requests[0]!.body);
    expect(body).not.toHaveProperty("source");
    expect(body).not.toHaveProperty("requiredLabels");
  });

  it.each([
    ["source", { source: "schedule" }, /source must be api, ui, or webhook; received schedule/],
    [
      "required-labels (invalid JSON)",
      { "required-labels": "not-json" },
      /required-labels must be valid JSON/,
    ],
    [
      "required-labels (not an array)",
      { "required-labels": "{}" },
      /required-labels must be a JSON array of strings/,
    ],
    [
      "required-labels (JSON null)",
      { "required-labels": "null" },
      /required-labels must be a JSON array of strings/,
    ],
    [
      "required-labels (non-string element)",
      { "required-labels": "[1]" },
      /required-labels must be a JSON array of strings/,
    ],
  ] satisfies [string, Record<string, string>, RegExp][])(
    "rejects an invalid %s value before making a request",
    async (_name, overrides, expectedError) => {
      const server = await serve(() => ({ body: {} }));

      const result = await runAction({ ...baseDispatchInputs(server.origin), ...overrides });

      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(expectedError);
      expect(server.requests).toHaveLength(0);
    },
  );
});
