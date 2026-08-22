import { describe, expect, it } from "vitest";

import {
  gitFailure,
  MAX_GIT_DIAGNOSTIC_BYTES,
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
    expect(diagnostic).toContain("Authorization: [redacted]");
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
    expect(diagnostic).toContain("Authorization: [redacted]");
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
      "fatal\nAuthorization: token totally-secret-value\nretry failed",
    );

    expect(diagnostic).toBe("fatal Authorization: [redacted] retry failed");
    expect(diagnostic).not.toContain("totally-secret-value");
  });

  it("redacts quoted structured keys and percent-encoded query keys", () => {
    const diagnostic = sanitizeGitDiagnostic(
      '{"password":"SUPERSECRET","access_token":"ALSOSECRET"} ' +
        "https://example.com/repo.git?private%5Ftoken=QUERYSECRET&ref=main",
    );

    expect(diagnostic).not.toContain("SUPERSECRET");
    expect(diagnostic).not.toContain("ALSOSECRET");
    expect(diagnostic).not.toContain("QUERYSECRET");
    expect(diagnostic).toContain("private%5Ftoken=[redacted]");
  });

  it("handles many unterminated control-string prefixes in one linear scan", () => {
    expect(sanitizeGitDiagnostic("\u001b]".repeat(32_000))).toBe("");
  });

  it("consumes complete ESC character-set designations before token matching", () => {
    const diagnostic = sanitizeGitDiagnostic("fatal: gh\u001b(Bp_SUPERSECRET");
    expect(diagnostic).toBe("fatal: [redacted]");
    expect(diagnostic).not.toContain("SUPERSECRET");
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
  });
});
