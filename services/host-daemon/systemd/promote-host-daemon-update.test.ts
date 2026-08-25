import { describe, expect, it } from "vitest";

import {
  assertProtectedUpdateRootPath,
  promotionWorkPrefix,
} from "./promote-host-daemon-update.mjs";

type PathStat = {
  uid: number;
  mode: number;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
};

function pathStat(
  options: { uid?: number; mode?: number; directory?: boolean; symbolicLink?: boolean } = {},
): PathStat {
  return {
    uid: options.uid ?? 0,
    mode: options.mode ?? 0o755,
    isDirectory: () => options.directory ?? true,
    isSymbolicLink: () => options.symbolicLink ?? false,
  };
}

function statMap(entries: Record<string, PathStat>): {
  calls: string[];
  stat: (path: string) => PathStat;
} {
  const calls: string[] = [];
  return {
    calls,
    stat: (path) => {
      calls.push(path);
      const value = entries[path];
      if (value === undefined) throw new Error("not found");
      return value;
    },
  };
}

describe("systemd update-root protection", () => {
  it("checks every root-owned ancestor before trusting a custom update root", () => {
    const fixture = statMap({
      "/": pathStat(),
      "/srv": pathStat(),
      "/srv/auto-harness": pathStat(),
      "/srv/auto-harness/updates": pathStat(),
    });

    expect(() =>
      assertProtectedUpdateRootPath("/srv/auto-harness/updates", fixture.stat),
    ).not.toThrow();
    expect(fixture.calls).toEqual(["/", "/srv", "/srv/auto-harness", "/srv/auto-harness/updates"]);
  });

  it("rejects a writable ancestor before a harness user can substitute the checked leaf", () => {
    const fixture = statMap({
      "/": pathStat(),
      "/home": pathStat(),
      "/home/harness": pathStat({ uid: 501, mode: 0o700 }),
      "/home/harness/updates": pathStat(),
    });

    expect(() => assertProtectedUpdateRootPath("/home/harness/updates", fixture.stat)).toThrow(
      "root-owned and not group/world writable: /home/harness",
    );
    expect(fixture.calls).toEqual(["/", "/home", "/home/harness"]);
  });

  it("rejects symlink and noncanonical ancestor substitution paths", () => {
    const symlinkFixture = statMap({
      "/": pathStat(),
      "/srv": pathStat({ symbolicLink: true }),
    });

    expect(() => assertProtectedUpdateRootPath("/srv/updates", symlinkFixture.stat)).toThrow(
      "update root ancestor is a symbolic link: /srv",
    );
    expect(() => assertProtectedUpdateRootPath("/srv/../updates", symlinkFixture.stat)).toThrow(
      "update root must be a canonical absolute path",
    );
    expect(symlinkFixture.calls).toEqual(["/", "/srv"]);
  });

  it("stages promotion below the protected releases tree for an atomic rename", () => {
    expect(promotionWorkPrefix("/srv/auto-harness/updates")).toBe(
      "/srv/auto-harness/updates/releases/.auto-harness-promote-",
    );
    expect(promotionWorkPrefix("/srv/auto-harness/updates")).not.toContain("/tmp/");
  });
});
