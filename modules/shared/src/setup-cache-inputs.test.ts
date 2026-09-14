import { describe, expect, it } from "vitest";

import {
  isSetupCacheHostInputPath,
  isSetupCacheInputPath,
  MAX_SETUP_CACHE_INPUTS,
  MAX_SETUP_CACHE_INPUT_LENGTH,
  parseSetupCacheHostInputs,
  parseSetupCacheHostInputsField,
  parseSetupCacheInputs,
  parseSetupCacheInputsField,
  presentSetupCacheHostInputs,
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
    expect(isSetupCacheInputPath("")).toBe(false);
    expect(isSetupCacheInputPath("C:foo")).toBe(false);
    expect(isSetupCacheInputPath("C:/lock")).toBe(false);
    expect(isSetupCacheInputPath("foo\u007fbar")).toBe(false);
    expect(isSetupCacheInputPath("foo//bar")).toBe(false);
  });

  it("rejects undeclared-style discovery and unsafe paths", () => {
    expect(() => parseSetupCacheInputs("pnpm-lock.yaml", "setupCacheInputs")).toThrow(
      "string array",
    );
    expect(() => parseSetupCacheInputs([1], "setupCacheInputs")).toThrow("string array");
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
    expect(presentSetupCacheInputs(undefined, "setupCacheInputs")).toBeUndefined();
    expect(parseSetupCacheInputsField("", "setupCacheInputs")).toEqual([]);
  });
});

describe("parseSetupCacheHostInputs", () => {
  it("accepts absolute host paths and dedupes them", () => {
    expect(parseSetupCacheHostInputs(undefined, "setupCacheHostInputs")).toBeUndefined();
    expect(parseSetupCacheHostInputs([], "setupCacheHostInputs")).toEqual([]);
    expect(
      parseSetupCacheHostInputs(
        [
          "/opt/auto-harness/setup/host-environment",
          "/opt/auto-harness/setup/host-environment",
          "C:\\auto-harness\\setup\\host-environment",
        ],
        "setupCacheHostInputs",
      ),
    ).toEqual([
      "/opt/auto-harness/setup/host-environment",
      "C:\\auto-harness\\setup\\host-environment",
    ]);
    expect(isSetupCacheHostInputPath("/opt/auto-harness/setup/host-environment")).toBe(true);
    expect(isSetupCacheHostInputPath("\\\\host\\share\\file")).toBe(true);
    expect(isSetupCacheHostInputPath("//host/share/file")).toBe(true);
    expect(isSetupCacheHostInputPath("d:/harness/env")).toBe(true);
    expect(isSetupCacheHostInputPath("")).toBe(false);
    expect(isSetupCacheHostInputPath("/")).toBe(false);
    expect(isSetupCacheHostInputPath("C:\\")).toBe(false);
    expect(isSetupCacheHostInputPath("pnpm-lock.yaml")).toBe(false);
    expect(isSetupCacheHostInputPath("/opt//env")).toBe(false);
    expect(isSetupCacheHostInputPath(`/opt/${"x".repeat(MAX_SETUP_CACHE_INPUT_LENGTH)}`)).toBe(
      false,
    );
    expect(isSetupCacheHostInputPath("/opt/\u007fenv")).toBe(false);
  });

  it("rejects relative checkout extras and unsafe host paths", () => {
    expect(() => parseSetupCacheHostInputs(" /opt/env", "setupCacheHostInputs")).toThrow(
      "string array",
    );
    expect(() => parseSetupCacheHostInputs([1], "setupCacheHostInputs")).toThrow("string array");
    expect(() => parseSetupCacheHostInputs([""], "setupCacheHostInputs")).toThrow("non-empty");
    expect(() => parseSetupCacheHostInputs(["pnpm-lock.yaml"], "setupCacheHostInputs")).toThrow(
      "absolute host paths",
    );
    expect(() =>
      parseSetupCacheHostInputs(["../host-environment"], "setupCacheHostInputs"),
    ).toThrow("absolute host paths");
    expect(() => parseSetupCacheHostInputs(["/opt/../etc/passwd"], "setupCacheHostInputs")).toThrow(
      "absolute host paths",
    );
    expect(() => parseSetupCacheHostInputs(["/opt/./env"], "setupCacheHostInputs")).toThrow(
      "absolute host paths",
    );
    expect(() => parseSetupCacheHostInputs(["/opt/\u0000env"], "setupCacheHostInputs")).toThrow(
      "absolute host paths",
    );
    expect(() =>
      parseSetupCacheHostInputs([`/${"x".repeat(4096)}`], "setupCacheHostInputs"),
    ).toThrow("at most 4096");
    expect(() =>
      parseSetupCacheHostInputs(
        Array.from({ length: MAX_SETUP_CACHE_INPUTS + 1 }, (_, i) => `/${String(i)}`),
        "setupCacheHostInputs",
      ),
    ).toThrow(`at most ${String(MAX_SETUP_CACHE_INPUTS)}`);
  });

  it("splits textarea lines without inventing undeclared files", () => {
    expect(
      parseSetupCacheHostInputsField(
        "/opt/auto-harness/setup/host-environment\n/opt/auto-harness/setup/repo-abc",
        "setupCacheHostInputs",
      ),
    ).toEqual(["/opt/auto-harness/setup/host-environment", "/opt/auto-harness/setup/repo-abc"]);
    expect(
      presentSetupCacheHostInputs(
        ["/opt/auto-harness/setup/host-environment"],
        "setupCacheHostInputs",
      ),
    ).toEqual(["/opt/auto-harness/setup/host-environment"]);
    expect(presentSetupCacheHostInputs([], "setupCacheHostInputs")).toBeUndefined();
    expect(presentSetupCacheHostInputs(undefined, "setupCacheHostInputs")).toBeUndefined();
    expect(parseSetupCacheHostInputsField("", "setupCacheHostInputs")).toEqual([]);
  });
});
