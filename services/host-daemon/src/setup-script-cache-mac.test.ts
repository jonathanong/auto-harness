import { describe, expect, it } from "vitest";

import {
  setupCacheFileName,
  signSetupCachePayload,
  verifySetupCachePayload,
} from "./setup-script-cache-mac.ts";

const payload = {
  worktreeId: "wt-1",
  cwd: "/wt/one",
  fingerprint: "abc",
  environment: { TOKEN: "x", PATH: "/bin" },
};

describe("setup-cache MAC", () => {
  it("binds the sidecar name and payload to worktree identity", () => {
    expect(setupCacheFileName("wt-1", "/wt/one")).not.toBe(setupCacheFileName("wt-2", "/wt/one"));
    expect(setupCacheFileName("wt-1", "/wt/one")).not.toBe(setupCacheFileName("wt-1", "/wt/two"));
    expect(setupCacheFileName("wt-1", "/wt/one")).toMatch(/^[0-9a-f]{64}$/);
    const mac = signSetupCachePayload(payload);
    expect(verifySetupCachePayload({ ...payload, mac })).toBe(true);
    expect(verifySetupCachePayload({ ...payload, worktreeId: "wt-2", mac })).toBe(false);
    expect(verifySetupCachePayload({ ...payload, cwd: "/wt/two", mac })).toBe(false);
    expect(verifySetupCachePayload({ ...payload, fingerprint: "def", mac })).toBe(false);
    expect(
      verifySetupCachePayload({ ...payload, environment: { TOKEN: "y", PATH: "/bin" }, mac }),
    ).toBe(false);
  });

  it("rejects missing, short, and non-hex MACs", () => {
    expect(verifySetupCachePayload({ ...payload, mac: 1 })).toBe(false);
    expect(verifySetupCachePayload({ ...payload, mac: "abcd" })).toBe(false);
    expect(verifySetupCachePayload({ ...payload, mac: "z".repeat(64) })).toBe(false);
    expect(verifySetupCachePayload({ ...payload, mac: "0".repeat(64) })).toBe(false);
    const empty = { ...payload, environment: { TOKEN: "" } };
    expect(verifySetupCachePayload({ ...empty, mac: signSetupCachePayload(empty) })).toBe(true);
    const none = { ...payload, environment: {} };
    expect(verifySetupCachePayload({ ...none, mac: signSetupCachePayload(none) })).toBe(true);
    const missing = { ...payload, environment: { TOKEN: "x", GONE: undefined } };
    expect(verifySetupCachePayload({ ...missing, mac: signSetupCachePayload(missing) })).toBe(true);
  });
});
