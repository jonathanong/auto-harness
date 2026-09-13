/* eslint-disable max-lines, unicorn/consistent-function-scoping -- Git command cases use local scenario helpers. */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  CheckoutFetchError,
  gitFailure,
  MAX_CAPTURED_GIT_STDOUT_BYTES,
  MAX_GIT_DIAGNOSTIC_BYTES,
  refetchConfiguredRemotes,
  runGit,
  sanitizeGitDiagnostic,
} from "./git-commands.ts";

describe("sanitizeGitDiagnostic", () => {
  it("redacts URL userinfo and token-shaped credentials", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "fatal: https://oauth:secret-token@example.com/repo.git " +
        "Authorization: Bearer bearer-secret token=token-secret ghp_test-secret",
    );

    expect(diagnostic).toContain("https://[redacted]@example.com/repo.git");
    expect(diagnostic).not.toContain("secret-token");
    expect(diagnostic).not.toContain("bearer-secret");
    expect(diagnostic).not.toContain("token-secret");
    expect(diagnostic).not.toContain("ghp_test-secret");
  });

  it("redacts underscore-prefixed private tokens, dotted bearer tokens, and encoded userinfo", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "fatal: https://oauth%40example.com:encoded-secret@example.com/repo.git " +
        "_private_token=private-secret Authorization: Bearer eyJ.header.payload.signature",
    );

    expect(diagnostic).toContain("https://[redacted]@example.com/repo.git");
    expect(diagnostic).toContain("_private_token=[redacted]");
    expect(diagnostic).not.toContain("oauth%40example.com");
    expect(diagnostic).not.toContain("encoded-secret");
    expect(diagnostic).not.toContain("private-secret");
    expect(diagnostic).not.toContain("eyJ.header.payload.signature");
  });

  it("removes terminal controls and bounds UTF-8 output", () => {
    const diagnostic = sanitizeGitDiagnostic(`\u001b[31mfatal\u001b[0m: ${"é".repeat(2_000)}`);

    expect(diagnostic).not.toContain("\u001b");
    expect(Buffer.byteLength(diagnostic, "utf8")).toBeLessThanOrEqual(MAX_GIT_DIAGNOSTIC_BYTES);
    expect(diagnostic).toContain("[diagnostic truncated]");
  });

  it("removes complete 8-bit C1 escape sequences and standalone C1 controls", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "fatal: \u009b31mcheckout\u009b0m \u009d0;window title\u0007" +
        "\u0090device-control\u009c\u009eprivacy\u001b\\\u009fapplication\u009c\u0084failed",
    );

    expect(diagnostic).toBe("fatal: checkout failed");
    expect(diagnostic).not.toMatch(/[\u0080-\u009f]/);
  });

  it("removes seven-bit terminal control strings before matching credentials", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "Authorization: Bearer aaa\u001b]0;window\u0007.bbb\u001b^privacy\u001b\\.ccc",
    );

    expect(diagnostic).toBe("Authorization: [redacted]");
    expect(diagnostic).not.toContain("aaa.bbb.ccc");
    expect(diagnostic).not.toContain("window");
    expect(diagnostic).not.toContain("privacy");
  });

  it("redacts complete authorization values for arbitrary schemes", () => {
    const diagnostic = sanitizeGitDiagnostic(
      'fatal\n{"Authorization":"token totally-secret-value"}\nretry failed',
    );

    expect(diagnostic).toBe('fatal {"Authorization":[redacted] retry failed');
    expect(diagnostic).not.toContain("totally-secret-value");
  });

  it("redacts quoted structured keys and percent-encoded query keys", () => {
    const diagnostic = sanitizeGitDiagnostic(
      '{"password":"prefix\\\"SUPERSECRET","access_token":"ALSOSECRET"}\n' +
        "https://example.com/repo.git?private%5Ftoken=QUERYSECRET&ref=main",
    );

    expect(diagnostic).not.toContain("SUPERSECRET");
    expect(diagnostic).not.toContain("QUERYSECRET");
    expect(diagnostic).toContain("private%5Ftoken=[redacted]");
  });

  it("redacts provider-prefixed signed URL credentials", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "https://example.com/object?X-Amz-Credential=AKIASECRET&X-Amz-Signature=SIGNEDSECRET" +
        "&X-Amz-Security-Token=SESSIONSECRET&X-Goog-Credential=GOOGSECRET" +
        "&X-Goog-Signature=GOOGSIGNATURE&AWSAccessKeyId=LEGACYSECRET" +
        "&X-Amz-Date=20260907T000000Z&ref=main",
    );

    expect(diagnostic).not.toMatch(
      /AKIASECRET|SIGNEDSECRET|SESSIONSECRET|GOOGSECRET|GOOGSIGNATURE|LEGACYSECRET/,
    );
    expect(diagnostic).toContain("X-Amz-Credential=[redacted]");
    expect(diagnostic).toContain("X-Amz-Signature=[redacted]");
    expect(diagnostic).toContain("X-Amz-Security-Token=[redacted]");
    expect(diagnostic).toContain("X-Goog-Credential=[redacted]");
    expect(diagnostic).toContain("X-Goog-Signature=[redacted]");
    expect(diagnostic).toContain("AWSAccessKeyId=[redacted]");
    expect(diagnostic).toContain("X-Amz-Date=20260907T000000Z");
    expect(diagnostic).toContain("ref=main");
  });

  it("redacts CLI-style credential options and compact query aliases", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "git: --token=OPTIONSECRET\n" +
        "https://example.com/?apiKey=APISECRET&clientSecret=CLIENTSECRET&auth=AUTHSECRET" +
        "&oauthToken=OAUTHSECRET&oauthSignature=OAUTHSIGNATURE",
    );
    expect(diagnostic).toContain("--token=[redacted]");
    expect(diagnostic).toContain("apiKey=[redacted]");
    expect(diagnostic).toContain("clientSecret=[redacted]");
    expect(diagnostic).toContain("auth=[redacted]");
    expect(diagnostic).toContain("oauthToken=[redacted]");
    expect(diagnostic).toContain("oauthSignature=[redacted]");
    expect(diagnostic).not.toMatch(
      /OPTIONSECRET|APISECRET|CLIENTSECRET|AUTHSECRET|OAUTHSECRET|OAUTHSIGNATURE/,
    );
  });

  it("redacts prefixed credential keys without matching ordinary words", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "client_secret=CLIENTSECRET\nAWS_SECRET_ACCESS_KEY=AWSSECRET\n" +
        "x-access-token=ACCESSTOKEN\nsecretary=visible",
    );
    expect(diagnostic).toContain("client_secret=[redacted]");
    expect(diagnostic).toContain("AWS_SECRET_ACCESS_KEY=[redacted]");
    expect(diagnostic).toContain("x-access-token=[redacted]");
    expect(diagnostic).toContain("secretary=visible");
    expect(diagnostic).not.toMatch(/CLIENTSECRET|AWSSECRET|ACCESSTOKEN/);
  });

  it("preserves query parameters whose percent-encoded key is malformed", () => {
    expect(sanitizeGitDiagnostic("https://example.com/object?bad%=visible")).toContain(
      "bad%=visible",
    );
  });

  it("redacts multi-part unquoted credential values through end-of-line", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "fatal\npassword=correct horse, battery; staple\nretry failed",
    );
    expect(diagnostic).toBe("fatal password=[redacted] retry failed");
    expect(diagnostic).not.toContain("horse");
    expect(diagnostic).not.toContain("staple");
  });

  it("normalizes JSON-escaped URL slashes before redacting userinfo", () => {
    const diagnostic = sanitizeGitDiagnostic(
      '{"url":"https:\\/\\/oauth:SUPERSECRET@example.com/repo.git"}',
    );
    expect(diagnostic).toContain("https://[redacted]@example.com/repo.git");
    expect(diagnostic).not.toContain("SUPERSECRET");
  });

  it("handles many unterminated control-string prefixes in one linear scan", () => {
    expect(sanitizeGitDiagnostic("\u001b]".repeat(32_000))).toBe("");
  });

  it("consumes complete ESC character-set designations before token matching", () => {
    const diagnostic = sanitizeGitDiagnostic("fatal: gh\u001b(Bp_SUPERSECRET");
    expect(diagnostic).toBe("fatal: [redacted]");
    expect(diagnostic).not.toContain("SUPERSECRET");
  });

  it("removes seven-bit and C1 SOS strings before token matching", () => {
    const diagnostic = sanitizeGitDiagnostic(
      "fatal: gh\u001bXhidden\u001b\\p_FIRST gh\u0098hidden\u009cp_SECOND",
    );
    expect(diagnostic).toBe("fatal: [redacted] [redacted]");
    expect(diagnostic).not.toContain("FIRST");
    expect(diagnostic).not.toContain("SECOND");
  });

  it("redacts credentials containing terminal styling through runGit and gitFailure", async () => {
    const result = await runGit(
      {
        async run(options) {
          options.onChunk({
            stream: "stderr",
            data: "Authorization: Bearer \u001b[31meyJ.secret.token\u001b[0m",
          });
          return { exitCode: 1, timedOut: false, signal: null };
        },
      },
      "/repo",
      ["fetch"],
    );

    const failure = gitFailure("git fetch failed", result.stderr);
    expect(failure.message).toBe("git fetch failed: Authorization: [redacted]");
    expect(failure.message).not.toContain("eyJ.secret.token");
  });

  it("drops an incomplete line when the raw capture boundary splits a credential", async () => {
    const result = await runGit(
      {
        async run(options) {
          options.onChunk({
            stream: "stderr",
            data:
              "\u001b[31m".repeat(13_100) + "fatal: https://oauth:SUPERSECRET@example.com/repo.git",
          });
          return { exitCode: 1, timedOut: false, signal: null };
        },
      },
      "/repo",
      ["fetch"],
    );

    const failure = gitFailure("git fetch failed", result.stderr);
    expect(failure.message).toBe("git fetch failed");
    expect(failure.message).not.toContain("SUPERSECRET");
  });

  it("drops the incomplete line before an executor truncation marker", async () => {
    const result = await runGit(
      {
        async run(options) {
          options.onChunk({
            stream: "stderr",
            data: "fatal: https://oauth:SUPERSE",
          });
          options.onChunk({ stream: "stderr", data: "\n[output chunk truncated]\n" });
          return { exitCode: 1, timedOut: false, signal: null };
        },
      },
      "/repo",
      ["fetch"],
    );

    const failure = gitFailure("git fetch failed", result.stderr);
    expect(failure.message).toBe("git fetch failed: [output chunk truncated]");
    expect(failure.message).not.toContain("SUPERSE");
  });

  it("drops executor-truncated continuations through the next real line break", async () => {
    const result = await runGit(
      {
        async run(options) {
          options.onChunk({ stream: "stderr", data: "safe line\nAuthorization: Bearer " });
          options.onChunk({ stream: "stderr", data: "\n[output chunk truncated]\n" });
          options.onChunk({ stream: "stderr", data: "dotted.secret.token\nstill safe" });
          return { exitCode: 1, timedOut: false, signal: null };
        },
      },
      "/repo",
      ["fetch"],
    );

    const failure = gitFailure("git fetch failed", result.stderr);
    expect(failure.message).toContain("safe line");
    expect(failure.message).toContain("still safe");
    expect(failure.message).not.toContain("dotted.secret.token");
  });

  it("records multibyte capture truncation explicitly", async () => {
    const result = await runGit(
      {
        async run(options) {
          options.onChunk({
            stream: "stderr",
            data:
              "safe line\n" +
              "é".repeat(32_750) +
              " https://oauth:SUPERSECRET@example.com/repo.git",
          });
          return { exitCode: 1, timedOut: false, signal: null };
        },
      },
      "/repo",
      ["fetch"],
    );

    const failure = gitFailure("git fetch failed", result.stderr);
    expect(failure.message).toBe("git fetch failed: safe line");
    expect(failure.message).not.toContain("SUPERSECRET");
  });

  it("returns an empty diagnostic when Git emitted no stderr", () => {
    expect(sanitizeGitDiagnostic("\n\t")).toBe("");
    expect(gitFailure("git failed").message).toBe("git failed");
    expect(sanitizeGitDiagnostic("\u001b\u0001visible")).toBe("visible");
  });

  it("bounds repeated stderr chunks and drops marker continuations without line breaks", async () => {
    const result = await runGit(
      {
        async run(options) {
          options.onChunk({ stream: "stderr", data: "safe\n" + "x".repeat(65_531) });
          options.onChunk({ stream: "stderr", data: "ignored" });
          options.onChunk({ stream: "stderr", data: "\n[output chunk truncated]\n" });
          options.onChunk({ stream: "stderr", data: "secret-continuation" });
          return { exitCode: undefined, timedOut: false, signal: null };
        },
      },
      "/repo",
      ["fetch"],
    );
    expect(result).toMatchObject({ exitCode: 1, stderr: "safe [output chunk truncated]" });
  });
});

describe("runGit executable resolution", () => {
  function stubBinary(dir: string, filename: string): void {
    // Mode 0o755: resolution requires POSIX candidates to actually be
    // executable, not merely present.
    writeFileSync(join(dir, filename), "", { mode: 0o755 });
  }

  it("resolves git from PATH, not from a malicious git.exe planted in the untrusted checkout cwd", async () => {
    // Regression guard for #349's runGit call site specifically: an
    // untrusted checkout used as cwd plants a same-named git.exe. runGit
    // must spawn the trusted PATH-resolved binary, never a bare "git" that
    // Windows' cwd-first executable search would resolve from cwd instead.
    const untrustedCheckout = mkdtempSync(join(tmpdir(), "auto-harness-run-git-untrusted-"));
    stubBinary(untrustedCheckout, "git.exe");
    const trustedBinDir = mkdtempSync(join(tmpdir(), "auto-harness-run-git-trusted-"));
    stubBinary(trustedBinDir, "git.exe");

    let capturedArgv0: string | undefined;
    await runGit(
      {
        async run(options) {
          capturedArgv0 = options.argv[0];
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      untrustedCheckout,
      ["status"],
      undefined,
      { PATH: trustedBinDir, PATHEXT: ".EXE" },
      "win32",
    );

    expect(capturedArgv0).toBe(join(trustedBinDir, "git.exe"));
    expect(capturedArgv0).not.toBe(join(untrustedCheckout, "git.exe"));
  });

  it("requests complete chunks for structured Git output", async () => {
    let preserveOutputChunks: boolean | undefined;
    const output = "path/" + "x".repeat(40_000) + "\0";
    const result = await runGit(
      {
        async run(options) {
          preserveOutputChunks = options.preserveOutputChunks;
          options.onChunk({ stream: "stdout", data: output });
          return { exitCode: 0, timedOut: false, signal: null };
        },
      },
      "/repo",
      ["ls-files", "-z"],
    );

    expect(preserveOutputChunks).toBe(true);
    expect(result.stdout).toBe(output);
  });

  it("fails closed when structured Git stdout exceeds its total capture bound", async () => {
    await expect(
      runGit(
        {
          async run(options) {
            options.onChunk({
              stream: "stdout",
              data: "x".repeat(MAX_CAPTURED_GIT_STDOUT_BYTES + 1),
            });
            return { exitCode: 0, timedOut: false, signal: null };
          },
        },
        "/repo",
        ["ls-files", "-z"],
      ),
    ).rejects.toThrow(
      `Git stdout exceeded the ${MAX_CAPTURED_GIT_STDOUT_BYTES}-byte capture limit`,
    );
  });
});

describe("refetchConfiguredRemotes", () => {
  function runner(results: Array<{ exitCode: number; stdout?: string }>) {
    return {
      async run(options: Parameters<Parameters<typeof runGit>[0]["run"]>[0]) {
        const result = results.shift()!;
        if (result.stdout) options.onChunk({ stream: "stdout", data: result.stdout });
        return { exitCode: result.exitCode, timedOut: false, signal: null };
      },
    };
  }

  it("fails for a remote-list error or an empty remote list", async () => {
    await expect(refetchConfiguredRemotes(runner([{ exitCode: 1 }]), "/repo")).resolves.toBe(false);
    await expect(refetchConfiguredRemotes(runner([{ exitCode: 0 }]), "/repo")).resolves.toBe(false);
  });

  it("fetches every configured remote and stops on the first failure", async () => {
    await expect(
      refetchConfiguredRemotes(
        runner([{ exitCode: 0, stdout: "origin\nupstream\n" }, { exitCode: 0 }, { exitCode: 0 }]),
        "/repo",
      ),
    ).resolves.toBe(true);
    await expect(
      refetchConfiguredRemotes(
        runner([{ exitCode: 0, stdout: "origin\n" }, { exitCode: 1 }]),
        "/repo",
      ),
    ).resolves.toBe(false);
  });

  it("brands an exact refetch failure only when checkout recovery requests it", async () => {
    await expect(
      refetchConfiguredRemotes(
        runner([{ exitCode: 0, stdout: "origin\n" }, { exitCode: 1 }]),
        "/repo",
        undefined,
        true,
      ),
    ).rejects.toBeInstanceOf(CheckoutFetchError);
    await expect(
      refetchConfiguredRemotes(
        runner([{ exitCode: 0, stdout: "origin\n" }, { exitCode: 1 }]),
        "/repo",
      ),
    ).resolves.toBe(false);
  });

  it("normalizes thrown non-Error refetch failures and reports them to recovery", async () => {
    const failures: CheckoutFetchError[] = [];
    const throwingRunner = {
      async run(options: Parameters<Parameters<typeof runGit>[0]["run"]>[0]) {
        if (options.argv[1] === "remote") {
          options.onChunk({ stream: "stdout", data: "origin\n" });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        throw "network unavailable";
      },
    };

    await expect(
      refetchConfiguredRemotes(throwingRunner, "/repo", undefined, false, (failure) => {
        failures.push(failure);
      }),
    ).resolves.toBe(false);
    expect(failures.map((failure) => failure.message)).toEqual([
      "Failed to refetch remote origin: network unavailable",
    ]);

    await expect(
      refetchConfiguredRemotes(throwingRunner, "/repo", undefined, true),
    ).rejects.toThrow("Failed to refetch remote origin: network unavailable");
  });

  it("preserves thrown Error diagnostics in both refetch failure modes", async () => {
    const throwingRunner = {
      async run(options: Parameters<Parameters<typeof runGit>[0]["run"]>[0]) {
        if (options.argv[1] === "remote") {
          options.onChunk({ stream: "stdout", data: "origin\n" });
          return { exitCode: 0, timedOut: false, signal: null };
        }
        throw new Error("remote unavailable");
      },
    };

    await expect(refetchConfiguredRemotes(throwingRunner, "/repo", undefined, false)).resolves.toBe(
      false,
    );
    await expect(
      refetchConfiguredRemotes(throwingRunner, "/repo", undefined, true),
    ).rejects.toThrow("Failed to refetch remote origin: remote unavailable");
  });
});
