import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  applyExecutionProfile,
  executionProfileFingerprint,
  executionProfileReady,
  loadExecutionProfiles,
  parseExecutionProfiles,
  providerAccountReadiness,
  resolveExecutionProfile,
} from "./execution-profiles.ts";

describe("execution profiles", () => {
  it("parses per-account homes without exposing credentials", () => {
    const parsed = parseExecutionProfiles({
      maxConcurrentAssignments: 3,
      accounts: {
        "acct-b": { home: "/homes/b", env: { TOKEN: "secret-b" } },
        "acct-a": { home: "/homes/a" },
      },
    });
    expect(parsed.maxConcurrentAssignments).toBe(3);
    expect(parsed.profiles.get("acct-a")).toEqual({
      providerAccountId: "acct-a",
      home: "/homes/a",
      env: {},
    });
    expect(executionProfileFingerprint(parsed.profiles.get("acct-b")!)).toMatch(/^[0-9a-f]{64}$/);
    expect(executionProfileFingerprint(parsed.profiles.get("acct-b")!)).not.toContain("secret-b");
    expect(
      executionProfileFingerprint({
        providerAccountId: "acct-b",
        home: "/homes/b",
        env: { TOKEN: "secret-b" },
      }),
    ).toEqual(
      executionProfileFingerprint({
        providerAccountId: "acct-b",
        home: "/homes/b",
        env: { TOKEN: "other-secret" },
      }),
    );
    expect(
      executionProfileFingerprint({
        providerAccountId: "acct-b",
        home: "/homes/b",
        env: { TOKEN: "secret-b" },
      }),
    ).not.toEqual(
      executionProfileFingerprint({
        providerAccountId: "acct-b",
        home: "/homes/b",
        env: { OTHER: "secret-b" },
      }),
    );
    expect(resolveExecutionProfile(parsed, "acct-b")?.home).toBe("/homes/b");
    expect(resolveExecutionProfile(parsed, undefined)).toBeUndefined();
  });

  it("rejects relative homes, reserved env, and invalid caps", () => {
    expect(parseExecutionProfiles(undefined).profiles.size).toBe(0);
    expect(parseExecutionProfiles(null).profiles.size).toBe(0);
    expect(parseExecutionProfiles({ maxConcurrentAssignments: 3 }).maxConcurrentAssignments).toBe(
      3,
    );
    expect(() => parseExecutionProfiles([])).toThrow(/must be an object/);
    expect(() => parseExecutionProfiles({ account: {} })).toThrow(
      /execution profiles has unknown key: account/,
    );
    expect(() => parseExecutionProfiles({ maxConcurrentAssignments: 0 })).toThrow(/positive/);
    expect(() => parseExecutionProfiles({ maxConcurrentAssignments: 257 })).toThrow(/at most/);
    expect(() => parseExecutionProfiles({ accounts: "nope" })).toThrow(
      /accounts must be an object/,
    );
    expect(() => parseExecutionProfiles({ accounts: { "": { home: "/x" } } })).toThrow(/id/);
    expect(() =>
      parseExecutionProfiles({ accounts: { ["a".repeat(513)]: { home: "/x" } } }),
    ).toThrow(/id must be at most 512 characters/);
    expect(() => parseExecutionProfiles({ accounts: { a: "nope" } })).toThrow(/must be an object/);
    expect(() =>
      parseExecutionProfiles({ accounts: { a: { home: "/x", environment: {} } } }),
    ).toThrow(/execution profile a has unknown key: environment/);
    expect(() => parseExecutionProfiles({ accounts: { a: { home: "relative" } } })).toThrow(
      /absolute path/,
    );
    expect(() =>
      parseExecutionProfiles({ accounts: { a: { home: "/x", env: ["TOKEN"] } } }),
    ).toThrow(/must be an object/);
    expect(() =>
      parseExecutionProfiles({ accounts: { a: { home: "/x", env: { TOKEN: 1 } } } }),
    ).toThrow(/must be a string/);
    expect(() =>
      parseExecutionProfiles({ accounts: { a: { home: "/x", env: { HARNESS_API_KEY: "x" } } } }),
    ).toThrow(/reserved name/);
    expect(() =>
      parseExecutionProfiles({ accounts: { a: { home: "/x", env: { HOME: "/other" } } } }),
    ).toThrow(/reserved name/);
    expect(() =>
      parseExecutionProfiles({ accounts: { a: { home: "/x", env: { userprofile: "/other" } } } }),
    ).toThrow(/reserved name/);
    expect(() =>
      parseExecutionProfiles({ accounts: { a: { home: "/x", env: { "bad-name": "x" } } } }),
    ).toThrow(/invalid name/);
    expect(() =>
      parseExecutionProfiles({
        accounts: { a: { home: "/homes/shared" }, b: { home: "/homes/shared" } },
      }),
    ).toThrow(/reuses home/);
    const tooMany: Record<string, { home: string }> = {};
    for (let index = 0; index < 257; index += 1) {
      tooMany[`acct-${String(index)}`] = { home: `/homes/${String(index)}` };
    }
    expect(() => parseExecutionProfiles({ accounts: tooMany })).toThrow(/at most 256/);
  });

  it("loads a file and env override, and reports directory readiness", () => {
    const root = mkdtempSync(join(tmpdir(), "execution-profiles-"));
    const home = join(root, "acct");
    mkdirSync(home);
    const file = join(root, "profiles.json");
    writeFileSync(
      file,
      JSON.stringify({
        accounts: { acct: { home, env: { FOO: "1" } } },
      }),
    );
    const loaded = loadExecutionProfiles({
      HARNESS_EXECUTION_PROFILES: file,
      HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "2",
    });
    expect(loaded.maxConcurrentAssignments).toBe(2);
    expect(executionProfileReady(loaded.profiles.get("acct")!)).toBe(true);
    expect(providerAccountReadiness(loaded)).toEqual([
      {
        providerAccountId: "acct",
        ready: true,
        fingerprint: executionProfileFingerprint(loaded.profiles.get("acct")!),
      },
    ]);
    expect(loadExecutionProfiles({}).profiles.size).toBe(0);
    expect(
      loadExecutionProfiles({ HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "8" }).maxConcurrentAssignments,
    ).toBe(8);
    expect(() => loadExecutionProfiles({ HARNESS_MAX_CONCURRENT_ASSIGNMENTS: "nope" })).toThrow(
      /positive/,
    );
    expect(
      executionProfileReady({ providerAccountId: "x", home: join(root, "missing"), env: {} }),
    ).toBe(false);
    expect(executionProfileReady({ providerAccountId: "x", home: file, env: {} })).toBe(false);
    expect(
      executionProfileReady(
        { providerAccountId: "x", home: home, env: {} },
        () => true,
        () => {
          throw new Error("stat failed");
        },
      ),
    ).toBe(false);
  });

  it("applies isolated CLI homes for two accounts", () => {
    const a = applyExecutionProfile(
      { PATH: "/bin", HOME: "/daemon", HARNESS_API_KEY: "keep-out" },
      { providerAccountId: "a", home: "/homes/a", env: { FOO: "one" } },
    );
    const b = applyExecutionProfile(
      { PATH: "/bin", HOME: "/daemon" },
      { providerAccountId: "b", home: "/homes/b", env: { FOO: "two" } },
    );
    expect(a.HOME).toBe("/homes/a");
    expect(a.USERPROFILE).toBe("/homes/a");
    expect(a.FOO).toBe("one");
    expect(b.HOME).toBe("/homes/b");
    expect(b.FOO).toBe("two");
    expect(a.HARNESS_API_KEY).toBe("keep-out");
    expect(
      applyExecutionProfile(
        { PATH: "/bin" },
        { providerAccountId: "c", home: "/homes/c", env: { HARNESS_SKIP: "nope", OK: "yes" } },
      ),
    ).toMatchObject({ HOME: "/homes/c", OK: "yes" });
    expect(
      applyExecutionProfile(
        { PATH: "/bin" },
        {
          providerAccountId: "d",
          home: "/homes/d",
          env: { HOME: "/injected", USERPROFILE: "/injected", FOO: "ok" },
        },
      ),
    ).toMatchObject({ HOME: "/homes/d", USERPROFILE: "/homes/d", FOO: "ok" });
  });
});
