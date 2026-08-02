import { describe, expect, it, vi } from "vitest";

import { main } from "./cli.js";

describe("api cli", () => {
  it("prints help", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    await expect(main(["node", "api", "help"])).resolves.toBe(0);
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });

  it("rejects unknown command and bad port", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(main(["node", "api", "nope"])).resolves.toBe(1);
    await expect(main(["node", "api", "serve", "--port", "x"])).resolves.toBe(1);
    err.mockRestore();
  });
});
