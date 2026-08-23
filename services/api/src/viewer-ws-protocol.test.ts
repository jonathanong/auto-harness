import { describe, expect, it, vi } from "vitest";

import { authenticateViewer } from "./viewer-ws-protocol.ts";

describe("viewer websocket authentication", () => {
  it("falls back to request authentication when the URL is absent", async () => {
    const authenticate = vi.fn(async () => ({
      id: "viewer",
      username: "viewer",
      kind: "user" as const,
      role: "operator" as const,
    }));
    await expect(
      authenticateViewer({ url: undefined } as never, { authenticate } as never),
    ).resolves.toMatchObject({ id: "viewer" });
    expect(authenticate).toHaveBeenCalledOnce();
  });
});
