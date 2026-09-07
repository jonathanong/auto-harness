import { describe, expect, it, vi } from "vitest";

import { killGroupOrPid } from "./kill-group-or-pid.ts";

describe("killGroupOrPid", () => {
  it("signals the process group and stops there when it succeeds", () => {
    const kill = vi.fn();
    killGroupOrPid(kill, 123, "SIGTERM");
    expect(kill).toHaveBeenCalledExactlyOnceWith(-123, "SIGTERM");
  });

  it("falls back to a direct-pid signal when the group signal fails", () => {
    const kill = vi.fn().mockImplementationOnce(() => {
      throw new Error("ESRCH");
    });
    killGroupOrPid(kill, 123, "SIGKILL");
    expect(kill).toHaveBeenNthCalledWith(1, -123, "SIGKILL");
    expect(kill).toHaveBeenNthCalledWith(2, 123, "SIGKILL");
  });

  it("swallows a direct-pid failure too, once both targets are already gone", () => {
    const kill = vi.fn().mockImplementation(() => {
      throw new Error("ESRCH");
    });
    expect(() => killGroupOrPid(kill, 123, "SIGKILL")).not.toThrow();
  });
});
