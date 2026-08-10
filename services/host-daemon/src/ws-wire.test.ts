import { describe, expect, it } from "vitest";

import { writeWs } from "./ws-wire.ts";

describe("ws wire helpers", () => {
  it("settles callback writes and maps thrown non-Errors", async () => {
    await expect(
      writeWs({ send: (_: string, done: () => void) => done() } as never, "x"),
    ).resolves.toBeUndefined();
    await expect(
      writeWs(
        {
          send: () => {
            throw "raw";
          },
        } as never,
        "x",
      ),
    ).rejects.toThrow("raw");
    await expect(
      writeWs(
        { send: (_: string, done: (error: Error) => void) => done(new Error("bad")) } as never,
        "x",
      ),
    ).rejects.toThrow("bad");
  });
});
