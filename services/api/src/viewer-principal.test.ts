import { describe, expect, it } from "vitest";

import { viewerConnectionPrincipal } from "./viewer-principal.ts";

describe("viewerConnectionPrincipal", () => {
  it("keeps admin and user identities and drops other kinds", () => {
    expect(
      viewerConnectionPrincipal({
        id: "user:alice",
        username: "alice",
        role: "operator",
        kind: "user",
        allowedRepositoryIds: ["repo"],
      }),
    ).toEqual({
      id: "user:alice",
      username: "alice",
      role: "operator",
      kind: "user",
      allowedRepositoryIds: ["repo"],
    });
    expect(
      viewerConnectionPrincipal({
        id: "admin:root",
        username: "root",
        role: "admin",
        kind: "admin",
      }),
    ).toMatchObject({ id: "admin:root", kind: "admin" });
    expect(
      viewerConnectionPrincipal({
        id: "service:host",
        username: "host",
        role: "agent",
        kind: "service-account",
        boundHostId: "host",
      }),
    ).toBeUndefined();
    expect(viewerConnectionPrincipal(null)).toBeUndefined();
  });
});
