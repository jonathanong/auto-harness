import { describe, expect, it } from "vitest";

import { concatGzipMembers, gunzipToUtf8, gzipJsonlLines } from "./session-log-gzip.ts";

describe("session log gzip", () => {
  it("round-trips JSONL lines", () => {
    const gz = gzipJsonlLines(['{"seq":1}', '{"seq":2}']);
    expect(gunzipToUtf8(gz)).toBe('{"seq":1}\n{"seq":2}\n');
  });

  it("concatenates gzip members into one readable stream", () => {
    const combined = concatGzipMembers([
      gzipJsonlLines(['{"seq":1}']),
      gzipJsonlLines(['{"seq":2}']),
    ]);
    expect(gunzipToUtf8(combined)).toBe('{"seq":1}\n{"seq":2}\n');
  });
});
