import { describe, expect, it } from "vitest";

import { isSessionArchiveReadResponse } from "./session-archive-response.ts";

const archive = {
  state: "archived" as const,
  expiresAt: "2026-01-01T00:05:00.000Z",
  contentType: "application/x-ndjson",
  bodyBytes: 1,
};

describe("isSessionArchiveReadResponse", () => {
  it.each(["javascript:alert(1)", "not a URL", "http://archive.example/session.jsonl"])(
    "rejects non-HTTPS download URL %s",
    (downloadUrl) => {
      expect(isSessionArchiveReadResponse({ ...archive, downloadUrl })).toBe(false);
    },
  );

  it("accepts an HTTPS download URL", () => {
    expect(
      isSessionArchiveReadResponse({
        ...archive,
        downloadUrl: "https://archive.example/session.jsonl?sig=abc",
      }),
    ).toBe(true);
  });
});
