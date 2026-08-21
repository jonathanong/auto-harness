import { describe, expect, it } from "vitest";

import { MAX_GIT_DIAGNOSTIC_BYTES, sanitizeGitDiagnostic } from "./git-commands.ts";

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

  it("returns an empty diagnostic when Git emitted no stderr", () => {
    expect(sanitizeGitDiagnostic("\n\t")).toBe("");
  });
});
