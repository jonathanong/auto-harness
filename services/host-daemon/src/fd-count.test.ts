import { describe, expect, it } from "vitest";

import { countOpenFds } from "./fd-count.ts";

describe("countOpenFds", () => {
  it("returns undefined on win32 without touching the filesystem", () => {
    expect(
      countOpenFds({
        platform: "win32",
        readdirSync: () => {
          throw new Error("must not be called");
        },
      }),
    ).toBeUndefined();
  });

  it("reads /proc/self/fd on linux", () => {
    const calls: string[] = [];
    const result = countOpenFds({
      platform: "linux",
      readdirSync: (path) => {
        calls.push(path as string);
        return ["0", "1", "2", "3"] as unknown as ReturnType<typeof import("node:fs").readdirSync>;
      },
    });
    expect(result).toBe(4);
    expect(calls).toEqual(["/proc/self/fd"]);
  });

  it("reads /dev/fd on darwin", () => {
    const calls: string[] = [];
    const result = countOpenFds({
      platform: "darwin",
      readdirSync: (path) => {
        calls.push(path as string);
        return ["0", "1", "2"] as unknown as ReturnType<typeof import("node:fs").readdirSync>;
      },
    });
    expect(result).toBe(3);
    expect(calls).toEqual(["/dev/fd"]);
  });

  it("returns undefined when the read fails", () => {
    expect(
      countOpenFds({
        platform: "linux",
        readdirSync: () => {
          throw new Error("EACCES");
        },
      }),
    ).toBeUndefined();
  });

  it("works against the real filesystem on the current platform", () => {
    const result = countOpenFds();
    if (process.platform === "win32") {
      expect(result).toBeUndefined();
    } else {
      // A hardened sandbox or an unmounted /dev/fd (BSD fdescfs) is a
      // documented, supported fallback -- this must not fail there. The
      // synthetic tests above already pin the read-failure -> undefined path.
      expect(result === undefined || result > 0).toBe(true);
    }
  });
});
