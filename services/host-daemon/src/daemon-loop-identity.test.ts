import { describe, expect, it } from "vitest";

import type { DaemonConfig } from "./config-types.ts";
import { DaemonLoop } from "./daemon-loop.ts";
import { createLoopbackTransport } from "./loopback-transport.ts";

function minimalConfig(overrides: Partial<DaemonConfig> = {}): DaemonConfig {
  return { hostId: "host-1", repositories: [], providerAccounts: [], ...overrides };
}

function runnerIdentity(loop: DaemonLoop): { apiUrl: string; apiKey?: string } | undefined {
  return (
    loop as unknown as { runner: { deps: { identity?: { apiUrl: string; apiKey?: string } } } }
  ).runner.deps.identity;
}

describe("DaemonLoop session-runner identity wiring", () => {
  it("omits identity entirely when apiUrl is not configured", () => {
    const loop = new DaemonLoop({
      config: minimalConfig(),
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
    });
    expect(runnerIdentity(loop)).toBeUndefined();
  });

  it("omits apiKey from the identity when the config has none", () => {
    const loop = new DaemonLoop({
      config: minimalConfig({ apiUrl: "https://example.test" }),
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
    });
    expect(runnerIdentity(loop)).toEqual({ apiUrl: "https://example.test" });
  });

  it("includes apiKey in the identity when configured", () => {
    const loop = new DaemonLoop({
      config: minimalConfig({ apiUrl: "https://example.test", apiKey: "secret" }),
      transport: createLoopbackTransport({ sendToServer: () => undefined }),
    });
    expect(runnerIdentity(loop)).toEqual({ apiUrl: "https://example.test", apiKey: "secret" });
  });
});
