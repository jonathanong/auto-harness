import { describe, expect, it } from "vitest";

import {
  isSetupCacheInputPath,
  MAX_SETUP_CACHE_INPUTS,
  parseSetupCacheInputs,
  parseSetupCacheInputsField,
  presentSetupCacheInputs,
  splitSetupCacheInputLines,
} from "./setup-cache-inputs.ts";

describe("parseSetupCacheInputs", () => {
  it("accepts relative checkout paths and dedupes them", () => {
    expect(parseSetupCacheInputs(undefined, "setupCacheInputs")).toBeUndefined();
    expect(parseSetupCacheInputs([], "setupCacheInputs")).toEqual([]);
    expect(
      parseSetupCacheInputs(["pnpm-lock.yaml", "pnpm-lock.yaml", "Cargo.lock"], "setupCacheInputs"),
    ).toEqual(["pnpm-lock.yaml", "Cargo.lock"]);
    expect(isSetupCacheInputPath("subdir/pnpm-lock.yaml")).toBe(true);
  });

  it("rejects undeclared-style discovery and unsafe paths", () => {
    expect(() => parseSetupCacheInputs("pnpm-lock.yaml", "setupCacheInputs")).toThrow(
      "string array",
    );
    expect(() => parseSetupCacheInputs([""], "setupCacheInputs")).toThrow("non-empty");
    expect(() => parseSetupCacheInputs(["/etc/passwd"], "setupCacheInputs")).toThrow("relative");
    expect(() => parseSetupCacheInputs(["C:\\lock"], "setupCacheInputs")).toThrow("relative");
    expect(() => parseSetupCacheInputs(["foo\\bar"], "setupCacheInputs")).toThrow("relative");
    expect(() => parseSetupCacheInputs(["foo/../package.json"], "setupCacheInputs")).toThrow(
      "relative",
    );
    expect(() => parseSetupCacheInputs(["./package.json"], "setupCacheInputs")).toThrow("relative");
    expect(() => parseSetupCacheInputs(["foo\u0000bar"], "setupCacheInputs")).toThrow("relative");
    expect(() => parseSetupCacheInputs([`a${"x".repeat(4096)}`], "setupCacheInputs")).toThrow(
      "at most 4096",
    );
    expect(() =>
      parseSetupCacheInputs(
        Array.from({ length: MAX_SETUP_CACHE_INPUTS + 1 }, (_, i) => `f${String(i)}`),
        "setupCacheInputs",
      ),
    ).toThrow(`at most ${String(MAX_SETUP_CACHE_INPUTS)}`);
  });

  it("splits textarea lines without inventing undeclared files", () => {
    expect(splitSetupCacheInputLines("pnpm-lock.yaml\r\n\nCargo.lock\n")).toEqual([
      "pnpm-lock.yaml",
      "Cargo.lock",
    ]);
    expect(parseSetupCacheInputsField("pnpm-lock.yaml\nCargo.lock", "setupCacheInputs")).toEqual([
      "pnpm-lock.yaml",
      "Cargo.lock",
    ]);
    expect(presentSetupCacheInputs(["pnpm-lock.yaml"], "setupCacheInputs")).toEqual([
      "pnpm-lock.yaml",
    ]);
    expect(presentSetupCacheInputs([], "setupCacheInputs")).toBeUndefined();
  });
});
