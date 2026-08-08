import { describe, expect, it } from "vitest";

import {
  decodeSessionTargetOptionValue,
  encodeSessionTargetOptionValue,
} from "./session-target.ts";

describe("encodeSessionTargetOptionValue", () => {
  it("prefixes a provider-account id", () => {
    expect(encodeSessionTargetOptionValue({ kind: "provider-account", id: "acct-1" })).toBe(
      "account:acct-1",
    );
  });

  it("prefixes a command id", () => {
    expect(encodeSessionTargetOptionValue({ kind: "command", id: "cmd-1" })).toBe("command:cmd-1");
  });
});

describe("decodeSessionTargetOptionValue", () => {
  it("decodes an account: value", () => {
    expect(decodeSessionTargetOptionValue("account:acct-1")).toEqual({
      providerAccountId: "acct-1",
    });
  });

  it("decodes a command: value", () => {
    expect(decodeSessionTargetOptionValue("command:cmd-1")).toEqual({ commandId: "cmd-1" });
  });

  it("returns null for an empty id after a known prefix", () => {
    expect(decodeSessionTargetOptionValue("account:")).toBeNull();
    expect(decodeSessionTargetOptionValue("command:")).toBeNull();
  });

  it("returns null for an unrecognized value", () => {
    expect(decodeSessionTargetOptionValue("")).toBeNull();
    expect(decodeSessionTargetOptionValue("nonsense")).toBeNull();
  });
});
