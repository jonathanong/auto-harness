import { describe, expect, it } from "vitest";

import {
  decodeSessionRoutingFormData,
  decodeSessionTargetOptionValue,
  encodeSessionTargetOptionValue,
} from "./session-target.ts";

describe("encodeSessionTargetOptionValue", () => {
  it("prefixes a provider id", () => {
    expect(encodeSessionTargetOptionValue({ kind: "provider", id: "provider-1" })).toBe(
      "provider:provider-1",
    );
  });

  it("prefixes a command id", () => {
    expect(encodeSessionTargetOptionValue({ kind: "command", id: "cmd-1" })).toBe("command:cmd-1");
  });
});

describe("decodeSessionTargetOptionValue", () => {
  it("decodes a provider: value", () => {
    expect(decodeSessionTargetOptionValue("provider:provider-1")).toEqual({
      providerId: "provider-1",
    });
  });

  it("decodes a command: value", () => {
    expect(decodeSessionTargetOptionValue("command:cmd-1")).toEqual({ commandId: "cmd-1" });
  });

  it("returns null for an empty id after a known prefix", () => {
    expect(decodeSessionTargetOptionValue("provider:")).toBeNull();
    expect(decodeSessionTargetOptionValue("command:")).toBeNull();
  });

  it("returns null for an unrecognized value", () => {
    expect(decodeSessionTargetOptionValue("")).toBeNull();
    expect(decodeSessionTargetOptionValue("nonsense")).toBeNull();
  });

  it("returns a null target when the primary form field is absent", () => {
    const formData = {
      get: () => null,
      getAll: () => [],
    };
    expect(decodeSessionRoutingFormData(formData)).toEqual({ target: null, fallbacks: [] });
  });
});

describe("decodeSessionRoutingFormData", () => {
  it("preserves the primary target and fallback DOM order", () => {
    const fields = new Map<string, FormDataEntryValue[]>([
      ["target", ["command:cli"]],
      ["fallback", ["provider:one", "command:two"]],
    ]);
    const formData = {
      get: (name: string) => fields.get(name)?.[0] ?? null,
      getAll: (name: string) => fields.get(name) ?? [],
    };
    expect(decodeSessionRoutingFormData(formData)).toEqual({
      target: { commandId: "cli" },
      fallbacks: [{ providerId: "one" }, { commandId: "two" }],
    });
  });

  it("omits empty optional fallback selections", () => {
    const formData = {
      get: () => "provider:one",
      getAll: () => ["", "command:two"],
    };
    expect(decodeSessionRoutingFormData(formData)).toEqual({
      target: { providerId: "one" },
      fallbacks: [{ commandId: "two" }],
    });
  });
});
