import { gzipSync, gunzipSync } from "node:zlib";

/** Gzip JSONL lines as a single member. */
export function gzipJsonlLines(lines: readonly string[]): Buffer {
  const body = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
  return gzipSync(body);
}

/** Concatenate gzip members (valid gzip; gunzip reads them in order). */
export function concatGzipMembers(parts: readonly Buffer[]): Buffer {
  return Buffer.concat(parts);
}

export function gunzipToUtf8(buf: Buffer): string {
  return gunzipSync(buf).toString("utf8");
}
