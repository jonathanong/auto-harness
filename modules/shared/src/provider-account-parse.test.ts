import { describe, expect, it } from "vitest";

import { parseProviderAccountOverrides, parseProviderAccounts } from "./provider-account-parse.ts";

describe("parseProviderAccountOverrides", () => {
  it("undefined input inherits (returns undefined)", () => {
    expect(parseProviderAccountOverrides(undefined, "repository.demo")).toBeUndefined();
  });

  it("rejects a non-object value", () => {
    expect(() => parseProviderAccountOverrides(["nope"], "repository.demo")).toThrow(
      /providerAccountOverrides must be an object/,
    );
  });

  it("rejects a non-object override entry", () => {
    expect(() => parseProviderAccountOverrides({ acct1: "nope" }, "repository.demo")).toThrow(
      /providerAccountOverrides\.acct1 must be an object/,
    );
  });

  it("parses enabled and commandId", () => {
    expect(
      parseProviderAccountOverrides(
        { acct1: { enabled: false, commandId: "cmd-1" } },
        "repository.demo",
      ),
    ).toEqual({ acct1: { enabled: false, commandId: "cmd-1" } });
  });

  it("rejects a non-boolean enabled", () => {
    expect(() =>
      parseProviderAccountOverrides({ acct1: { enabled: "yes" } }, "repository.demo"),
    ).toThrow(/providerAccountOverrides\.acct1\.enabled must be a boolean/);
  });

  it("rejects an empty or non-string commandId", () => {
    expect(() =>
      parseProviderAccountOverrides({ acct1: { commandId: "" } }, "repository.demo"),
    ).toThrow(/providerAccountOverrides\.acct1\.commandId must be a non-empty string/);
    expect(() =>
      parseProviderAccountOverrides({ acct1: { commandId: 1 } }, "repository.demo"),
    ).toThrow(/providerAccountOverrides\.acct1\.commandId must be a non-empty string/);
  });

  it("allows an override with neither field set", () => {
    expect(parseProviderAccountOverrides({ acct1: {} }, "repository.demo")).toEqual({ acct1: {} });
  });
});

describe("parseProviderAccounts", () => {
  it("undefined input defaults to an empty array", () => {
    expect(parseProviderAccounts(undefined)).toEqual([]);
  });

  it("rejects a non-array value", () => {
    expect(() => parseProviderAccounts({})).toThrow(/providerAccounts must be an array/);
  });

  it("rejects a non-object entry", () => {
    expect(() => parseProviderAccounts(["nope"])).toThrow(
      /providerAccounts\[0\] must be an object/,
    );
  });

  it("requires providerAccountId", () => {
    expect(() => parseProviderAccounts([{}])).toThrow(
      /providerAccounts\[0\]: providerAccountId must be a non-empty string/,
    );
  });

  it("parses entries with and without commandId", () => {
    expect(
      parseProviderAccounts([
        { providerAccountId: "acct-1" },
        { providerAccountId: "acct-2", commandId: "cmd-1" },
      ]),
    ).toEqual([
      { providerAccountId: "acct-1" },
      { providerAccountId: "acct-2", commandId: "cmd-1" },
    ]);
  });

  it("rejects an empty or non-string commandId", () => {
    expect(() => parseProviderAccounts([{ providerAccountId: "a", commandId: "" }])).toThrow(
      /providerAccounts\[0\]\.commandId must be a non-empty string/,
    );
    expect(() => parseProviderAccounts([{ providerAccountId: "a", commandId: 1 }])).toThrow(
      /providerAccounts\[0\]\.commandId must be a non-empty string/,
    );
  });
});
