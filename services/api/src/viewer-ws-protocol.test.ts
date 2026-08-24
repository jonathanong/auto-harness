import { describe, expect, it, vi } from "vitest";

import { AuthService } from "./auth.ts";
import { isAllowedViewerOrigin, authenticateViewer } from "./viewer-ws-protocol.ts";

describe("viewer origin allowlist", () => {
  it("fails closed when origin or public base URL is missing or malformed", () => {
    expect(isAllowedViewerOrigin(undefined, "http://127.0.0.1:7421")).toBe(false);
    expect(isAllowedViewerOrigin("http://127.0.0.1:7421", "")).toBe(false);
    expect(isAllowedViewerOrigin("http://127.0.0.1:7421", undefined)).toBe(false);
    expect(isAllowedViewerOrigin("not a url", "http://127.0.0.1:7421")).toBe(false);
    expect(isAllowedViewerOrigin("http://127.0.0.1:7421", "not a url")).toBe(false);
    expect(isAllowedViewerOrigin("ftp://127.0.0.1:7421", "http://127.0.0.1:7421")).toBe(false);
    expect(isAllowedViewerOrigin("http://user:pass@127.0.0.1:7421", "http://127.0.0.1:7421")).toBe(
      false,
    );
  });

  it("matches the configured web origin and treats loopback aliases as one origin", () => {
    expect(isAllowedViewerOrigin("http://127.0.0.1:7421", "http://localhost:7421")).toBe(true);
    expect(isAllowedViewerOrigin("http://localhost:7421", "http://127.0.0.1:7421/app")).toBe(true);
    expect(isAllowedViewerOrigin("https://app.example.test", "https://app.example.test/")).toBe(
      true,
    );
    expect(isAllowedViewerOrigin("https://evil.example.test", "https://app.example.test")).toBe(
      false,
    );
    expect(isAllowedViewerOrigin("http://127.0.0.1:7422", "http://127.0.0.1:7421")).toBe(false);
    expect(isAllowedViewerOrigin("http://127.0.0.1:7431", "http://localhost:7421")).toBe(false);
    expect(isAllowedViewerOrigin("http://127.0.0.1:7431", "http://127.0.0.1:7421")).toBe(false);
    expect(isAllowedViewerOrigin("http://127.0.0.1:7431", "http://127.0.0.1:7431")).toBe(true);
  });

  it("rejects a viewer request whose Origin does not match", async () => {
    const auth = new AuthService({
      mode: "required",
      secret: "a".repeat(32),
      admins: Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
        "base64url",
      ),
    });
    const user = await auth.createUser({
      username: "alice",
      password: "password",
      role: "operator",
    });
    const ticket = await auth.issueViewerTicket(user);
    expect(
      await authenticateViewer(
        {
          url: `/ws/viewer?ticket=${encodeURIComponent(ticket)}`,
          headers: { origin: "https://evil.example.test" },
        } as never,
        auth,
        "https://app.example.test",
      ),
    ).toBeNull();
    expect(
      await authenticateViewer(
        {
          url: `/ws/viewer?ticket=${encodeURIComponent(ticket)}`,
          headers: { origin: "https://app.example.test" },
        } as never,
        auth,
      ),
    ).toBeNull();
    expect(
      await authenticateViewer(
        {
          url: `/ws/viewer?ticket=${encodeURIComponent(ticket)}`,
          headers: { origin: "https://app.example.test" },
        } as never,
        auth,
        "https://app.example.test",
      ),
    ).toMatchObject(user);
    expect(await auth.authenticateViewerTicket(ticket)).toBeNull();
  });
});

describe("viewer websocket authentication", () => {
  it("requires a one-time ticket when auth is required and falls back only when disabled", async () => {
    const authenticate = vi.fn(async () => ({
      id: "viewer",
      username: "viewer",
      kind: "user" as const,
      role: "operator" as const,
    }));
    await expect(
      authenticateViewer(
        { url: undefined, headers: { origin: "http://ui" } } as never,
        { authenticate, mode: "required" } as never,
        "http://ui",
      ),
    ).resolves.toBeNull();
    expect(authenticate).not.toHaveBeenCalled();
    await expect(
      authenticateViewer(
        { url: undefined, headers: {} } as never,
        { authenticate, mode: "disabled" } as never,
        "http://ui",
      ),
    ).resolves.toBeNull();
    await expect(
      authenticateViewer(
        { url: undefined, headers: { origin: "http://ui" } } as never,
        { authenticate, mode: "disabled" } as never,
        "http://ui",
      ),
    ).resolves.toMatchObject({ id: "viewer" });
    expect(authenticate).toHaveBeenCalledOnce();
  });
});
