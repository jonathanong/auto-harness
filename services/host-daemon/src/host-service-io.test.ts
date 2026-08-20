import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  defaultCheckoutRoot,
  defaultHostServiceRun,
  failedCommand,
  nodeHostServiceFs,
  resolveHome,
  resolveHostService,
  resolveUid,
  spawnStatus,
  writeMode,
} from "./host-service-io.ts";
import { memFs, seededFs } from "./host-service-test-helpers.ts";

describe("resolveHostService / defaults", () => {
  it("fills omitted paths from the process and checkout", () => {
    const ctx = resolveHostService({
      env: { HOME: "/h", APPDATA: "/ad" },
      log: () => undefined,
      error: () => undefined,
    });
    expect(ctx.fs).toBe(nodeHostServiceFs);
    expect(ctx.run).toBe(defaultHostServiceRun);
    expect(ctx.checkoutRoot).toBe(defaultCheckoutRoot());
    expect(ctx.nodePath).toBe(process.execPath);
    expect(ctx.home).toBe("/h");
    expect(ctx.appData).toBe("/ad");
    expect(ctx.launcherPath).toContain("auto-harness-host-daemon.mjs");
  });

  it("covers spawn/home/uid fallbacks", () => {
    expect(spawnStatus(0)).toBe(0);
    expect(spawnStatus(null)).toBe(1);
    expect(resolveHome("/h", {}, () => "/fb")).toBe("/h");
    expect(resolveHome(undefined, { HOME: "/home" }, () => "/fb")).toBe("/home");
    expect(resolveHome(undefined, { USERPROFILE: "/u" }, () => "/fb")).toBe("/u");
    expect(resolveHome(undefined, {}, () => "/fb")).toBe("/fb");
    expect(resolveUid(5, () => 9)).toBe(5);
    expect(resolveUid(undefined, () => 9)).toBe(9);
    expect(resolveUid(undefined, undefined)).toBe(1);
  });

  it("uses USERPROFILE and homedir fallbacks", () => {
    expect(
      resolveHostService({
        env: { USERPROFILE: "/u" },
        log: () => undefined,
        error: () => undefined,
        fs: seededFs(),
        run: () => ({ status: 0, stdout: "", stderr: "" }),
      }).home,
    ).toBe("/u");
    expect(
      resolveHostService({
        env: {},
        log: () => undefined,
        error: () => undefined,
        fs: seededFs(),
        run: () => ({ status: 0, stdout: "", stderr: "" }),
        home: "/explicit",
      }).appData,
    ).toMatch(/AppData/);
  });

  it("writeMode chmod's after write and failedCommand prefers stderr", () => {
    const fs = memFs();
    writeMode(fs, "/f", "x", 0o600);
    expect(fs.files.get("/f")).toBe("x");
    expect(fs.modes.get("/f")).toBe(0o600);
    writeMode(fs, "/g", "y", 0o600, true);
    expect(fs.flags.get("/g")).toBe("wx");
    expect(() => writeMode(fs, "/g", "z", 0o600, true)).toThrow(/EEXIST/);
    const errors: string[] = [];
    expect(failedCommand((m) => errors.push(m), "cmd", { status: 3, stdout: "", stderr: "" })).toBe(
      1,
    );
    expect(errors[0]).toMatch(/exit 3/);
    expect(failedCommand(() => undefined, "cmd", { status: 1, stdout: "out", stderr: "err" })).toBe(
      1,
    );
    const stdoutOnly: string[] = [];
    failedCommand((m) => stdoutOnly.push(m), "cmd", { status: 1, stdout: "out", stderr: "  " });
    expect(stdoutOnly[0]).toMatch(/out/);
  });

  it("defaultCheckoutRoot is this repository and default run covers success/ENOENT", () => {
    expect(
      nodeHostServiceFs.existsSync(
        join(
          defaultCheckoutRoot(),
          "services/host-daemon/systemd/auto-harness-host-daemon.service",
        ),
      ),
    ).toBe(true);
    const ok = defaultHostServiceRun(process.execPath, ["-e", "process.stdout.write('ok')"]);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toBe("ok");
    const missing = defaultHostServiceRun("auto-harness-host-service-missing-binary", []);
    expect(missing.status).toBe(1);
    expect(missing.stderr.length).toBeGreaterThan(0);
  });

  it("nodeHostServiceFs reads and writes a temp file", () => {
    const dir = mkdtempSync(join(tmpdir(), "ah-hs-"));
    const file = join(dir, "f.env");
    try {
      const staged = nodeHostServiceFs.mkdtempSync(join(dir, "ah-hs-"));
      const exclusive = join(staged, "e.env");
      nodeHostServiceFs.mkdirSync(dir, { recursive: true, mode: 0o755 });
      nodeHostServiceFs.writeFileSync(file, "A=1\n", { mode: 0o600 });
      nodeHostServiceFs.writeFileSync(exclusive, "B=1\n", { mode: 0o600, flag: "wx" });
      expect(nodeHostServiceFs.readFileSync(exclusive)).toBe("B=1\n");
      nodeHostServiceFs.chmodSync(file, 0o600);
      expect(nodeHostServiceFs.readFileSync(file)).toBe("A=1\n");
      expect(nodeHostServiceFs.existsSync(file)).toBe(true);
      nodeHostServiceFs.rmSync(file, { force: true });
      expect(nodeHostServiceFs.existsSync(file)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
