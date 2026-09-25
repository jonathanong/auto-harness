import { describe, expect, it } from "vitest";

import { CheckoutFetchError } from "./git-commands.ts";
import { FULL_COMMIT_ID, resolveCheckoutRef } from "./git-ref-resolution.ts";
import { scripted } from "../test-helpers/git-test-helpers.ts";

const sha1 = "728430f4".padEnd(40, "0");
const sha256 = "a".repeat(64);
const staleSha = "a0187545".padEnd(40, "0");

function rev(ref: string, exitCode = 0, stdout = "") {
  return {
    match: ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    exitCode,
    ...(stdout ? { stdout: `${stdout}\n` } : {}),
    ...(exitCode === 0 ? {} : { stderr: `bad ${ref}` }),
  };
}

const fetch = (exitCode = 0, stderr = "") => ({
  match: ["fetch", "--all", "--tags"],
  exitCode,
  stderr,
});
const remotes = (stdout: string, exitCode = 0) => ({ match: ["remote"], exitCode, stdout });

describe("FULL_COMMIT_ID", () => {
  it("accepts only full SHA-1 and SHA-256 object ids", () => {
    expect(FULL_COMMIT_ID.test(sha1)).toBe(true);
    expect(FULL_COMMIT_ID.test(sha256.toUpperCase())).toBe(true);
    expect(FULL_COMMIT_ID.test("728430f4")).toBe(false);
    expect(FULL_COMMIT_ID.test("main")).toBe(false);
  });
});

describe("resolveCheckoutRef with a full commit SHA", () => {
  it.each([sha1, sha256])("resolves %s locally without fetching", async (sha) => {
    const runner = scripted([rev(sha, 0, sha)]);
    await expect(resolveCheckoutRef(runner, "/wt", sha)).resolves.toBe(sha);
    expect(runner.remaining()).toBe(0);
  });

  it("fetches only when the commit is missing locally", async () => {
    const runner = scripted([rev(sha1, 1), fetch(), rev(sha1, 0, sha1)]);
    await expect(resolveCheckoutRef(runner, "/wt", sha1)).resolves.toBe(sha1);
    expect(runner.remaining()).toBe(0);
  });

  it("reports a failed fetch when the commit stays missing", async () => {
    const runner = scripted([rev(sha1, 1), fetch(1, "offline"), rev(sha1, 1)]);
    const result = resolveCheckoutRef(runner, "/wt", sha1);
    await expect(result).rejects.toBeInstanceOf(CheckoutFetchError);
    await expect(result).rejects.toThrow(`Failed to fetch ref ${sha1}: offline`);
  });

  it("reports an unresolved commit after a successful fetch", async () => {
    const runner = scripted([rev(sha1, 1), fetch(), rev(sha1, 1)]);
    await expect(resolveCheckoutRef(runner, "/wt", sha1)).rejects.toThrow(
      `Failed to resolve ref ${sha1}: bad ${sha1}`,
    );
  });
});

describe("resolveCheckoutRef with a branch or other named ref", () => {
  it("fetches first and prefers the remote-tracking tip over a stale local branch", async () => {
    const runner = scripted([
      rev("main", 0, staleSha),
      fetch(),
      remotes("origin\n"),
      rev("refs/remotes/origin/main", 0, sha1),
    ]);
    await expect(resolveCheckoutRef(runner, "/wt", "main")).resolves.toBe(sha1);
    // The stale local `main` entry is never consulted.
    expect(runner.remaining()).toBe(1);
  });

  it("tries origin before other remotes, then later remotes in listed order", async () => {
    const runner = scripted([
      fetch(),
      remotes("fork\norigin\nupstream\n"),
      rev("refs/remotes/origin/feature/x", 1),
      rev("refs/remotes/fork/feature/x", 1),
      rev("refs/remotes/upstream/feature/x", 0, sha1),
    ]);
    await expect(resolveCheckoutRef(runner, "/wt", "feature/x")).resolves.toBe(sha1);
    expect(runner.remaining()).toBe(0);
  });

  it.each([
    ["no remote-tracking branch", [remotes("origin\n"), rev("refs/remotes/origin/v1.2.3", 1)]],
    ["no configured remotes", [remotes("")]],
    ["an unreadable remote list", [remotes("", 1)]],
  ])("falls back to the ref itself with %s", async (_case, lookups) => {
    const runner = scripted([fetch(), ...lookups, rev("v1.2.3", 0, sha1)]);
    await expect(resolveCheckoutRef(runner, "/wt", "v1.2.3")).resolves.toBe(sha1);
    expect(runner.remaining()).toBe(0);
  });

  it.each(["HEAD", "main~1", "main^", "a..b", "main@{1}", "refs/heads/main", "-x", "a b", "x:y"])(
    "does not treat revision syntax %s as a remote branch name",
    async (ref) => {
      const runner = scripted([fetch(), rev(ref, 0, sha1)]);
      await expect(resolveCheckoutRef(runner, "/wt", ref)).resolves.toBe(sha1);
      expect(runner.remaining()).toBe(0);
    },
  );

  it("warns and uses the possibly stale remote-tracking tip when the fetch fails", async () => {
    const warnings: string[] = [];
    const runner = scripted([
      fetch(1, "Could not resolve host"),
      remotes("origin\n"),
      rev("refs/remotes/origin/main", 0, sha1),
    ]);
    await expect(
      resolveCheckoutRef(runner, "/wt", "main", undefined, (w) => warnings.push(w)),
    ).resolves.toBe(sha1);
    expect(warnings).toEqual([
      `Warning: fetch failed before resolving ref main; using possibly stale refs/remotes/origin/main at ${sha1}: Could not resolve host`,
    ]);
  });

  it("tolerates a failed fetch without a warning listener", async () => {
    const runner = scripted([fetch(1), remotes(""), rev("main", 0, staleSha)]);
    await expect(resolveCheckoutRef(runner, "/wt", "main")).resolves.toBe(staleSha);
  });

  it("fails as a checkout fetch failure when the fetch fails and nothing resolves", async () => {
    const runner = scripted([fetch(1, "offline"), remotes(""), rev("main", 1)]);
    const result = resolveCheckoutRef(runner, "/wt", "main");
    await expect(result).rejects.toBeInstanceOf(CheckoutFetchError);
    await expect(result).rejects.toThrow("Failed to fetch ref main: offline");
  });

  it("fails as a checkout fetch failure when the fetch process throws", async () => {
    const runner = {
      async run() {
        throw new Error("spawn failed");
      },
    };
    await expect(resolveCheckoutRef(runner, "/wt", "main")).rejects.toThrow(
      new CheckoutFetchError("Failed to fetch ref main: spawn failed"),
    );
  });
});
