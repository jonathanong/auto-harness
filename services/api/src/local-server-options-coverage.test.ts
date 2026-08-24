import { afterEach, expect, it, vi } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { publicBaseUrlFromEnv, resolvePublicBaseUrl } from "./local-http.ts";
import { startLocalServer } from "./local-server.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

it("forwards host messages to both the callback and websocket bridge", async () => {
  const plane = new ControlPlane();
  const messages: unknown[] = [];
  const server = await startLocalServer({
    port: 18_000 + Math.floor(Math.random() * 1_000),
    useDynamo: false,
    plane,
    onHostMessage: (_hostId, message) => messages.push(message),
  });
  try {
    plane.registerHost({ hostId: "host", worktrees: [] });
    plane.drainHost("host");
    expect(messages).toEqual([{ type: "host:drain" }]);
    expect(server.slackWorker).toBeUndefined();
  } finally {
    await server.close();
  }
});

it("uses the default public URL when constructing a Dynamo-backed plane", async () => {
  vi.stubEnv("HARNESS_PUBLIC_BASE_URL", "");
  const server = await startLocalServer({
    port: 19_000 + Math.floor(Math.random() * 1_000),
    useDynamo: true,
    enableWs: false,
  });
  try {
    expect(server.plane.state.publicBaseUrl).toBe("http://localhost:7421");
  } finally {
    await server.close();
  }
});

it("uses HARNESS_PUBLIC_BASE_URL as the viewer web origin", async () => {
  vi.stubEnv("HARNESS_PUBLIC_BASE_URL", " http://127.0.0.1:7431 ");
  expect(publicBaseUrlFromEnv()).toBe("http://127.0.0.1:7431");
  expect(resolvePublicBaseUrl()).toBe("http://127.0.0.1:7431");
  const server = await startLocalServer({
    port: 19_000 + Math.floor(Math.random() * 1_000),
    useDynamo: false,
    enableWs: false,
  });
  try {
    expect(server.plane.state.publicBaseUrl).toBe("http://127.0.0.1:7431");
  } finally {
    await server.close();
  }
});

it("prefers an explicit publicBaseUrl over the environment", () => {
  vi.stubEnv("HARNESS_PUBLIC_BASE_URL", "http://127.0.0.1:7431");
  expect(resolvePublicBaseUrl("http://127.0.0.1:7421")).toBe("http://127.0.0.1:7421");
  expect(publicBaseUrlFromEnv("")).toBeUndefined();
  expect(publicBaseUrlFromEnv("   ")).toBeUndefined();
  vi.stubEnv("HARNESS_PUBLIC_BASE_URL", "");
  expect(resolvePublicBaseUrl()).toBe("http://localhost:7421");
});
