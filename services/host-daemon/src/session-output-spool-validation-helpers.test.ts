import { PassThrough } from "node:stream";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";

import {
  abortArtifactReadIfTooLarge,
  collectBoundedOutput,
  preferArtifactLimitError,
  validateOutputReadSnapshot,
  type ArtifactStat,
} from "./session-output-spool-guards.ts";

function stat(overrides: Partial<ArtifactStat> = {}): ArtifactStat {
  return {
    dev: 1,
    ino: 2,
    size: 3,
    mtimeMs: 4,
    mode: 0,
    isFile: () => true,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    ...overrides,
  };
}

describe("session output read and archive validation", () => {
  it("bounds output while collecting stream chunks", async () => {
    await expect(
      collectBoundedOutput(Readable.from([Buffer.from("12"), Buffer.from("34")]), 4),
    ).resolves.toEqual({ chunks: [Buffer.from("12"), Buffer.from("34")], observedBytes: 4 });
    await expect(
      collectBoundedOutput(
        Readable.from([Buffer.from("12"), Buffer.from("345"), Buffer.from("ignored")]),
        4,
      ),
    ).resolves.toEqual({ chunks: [Buffer.from("12")], observedBytes: 5 });
  });

  it("validates output bytes against the before/after file snapshot", () => {
    const before = stat({ size: 2 });
    expect(
      validateOutputReadSnapshot({
        before,
        after: stat({ size: 3 }),
        chunks: [Buffer.from("{}")],
        observedBytes: 2,
        limit: 10,
      }),
    ).toEqual({
      ok: false,
      code: "output_changed",
      message: "Output changed while being read",
    });
  });

  it("aborts oversized archive streams and preserves the compressed-limit error", async () => {
    const validStream = new PassThrough();
    abortArtifactReadIfTooLarge(validStream, 3, 4, 10, "file.txt");
    expect(validStream.destroyed).toBe(false);
    validStream.destroy();

    const oversizedStream = new PassThrough();
    const streamError = new Promise<Error>((resolve) => {
      oversizedStream.once("error", resolve);
    });
    abortArtifactReadIfTooLarge(oversizedStream, 11, 10, 20, "file.txt");
    await expect(streamError).resolves.toMatchObject({
      message: "artifact grew while archiving: file.txt",
    });

    const sourceError = new Error("source read failed");
    const compressedLimitError = new Error("compressed limit reached");
    expect(preferArtifactLimitError(sourceError, undefined)).toBe(sourceError);
    expect(preferArtifactLimitError(sourceError, compressedLimitError)).toBe(compressedLimitError);
  });
});
