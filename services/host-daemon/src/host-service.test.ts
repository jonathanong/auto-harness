/* eslint-disable max-lines -- platform dispatch failures share the service fixture. */
import { describe, expect, it } from "vitest";

import {
  getHostServiceStatus,
  installHostService,
  restartHostService,
  uninstallHostService,
} from "./host-service.ts";
import type { HostServiceFs } from "./host-service-io.ts";
import { baseOpts, memFs, seededFs } from "./host-service-test-helpers.ts";

describe("unsupported platform / thrown failures", () => {
  it("dispatches service status through the platform adapter", () => {
    expect(
      getHostServiceStatus(
        baseOpts({
          platform: "linux",
          fs: seededFs(),
          run: () => ({
            status: 0,
            stdout: "LoadState=loaded\nActiveState=active\nSubState=running\n",
            stderr: "",
          }),
        }),
      ),
    ).toMatchObject({ state: "running" });
    expect(getHostServiceStatus(baseOpts({ platform: "aix", fs: seededFs() }))).toMatchObject({
      state: "unknown",
    });
    expect(restartHostService(baseOpts({ platform: "aix", fs: seededFs() }))).toBe(1);
    let linuxHandoffs = 0;
    expect(
      restartHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
          restartHandoff: () => {
            linuxHandoffs += 1;
          },
        }),
      ),
    ).toBe(0);
    expect(linuxHandoffs).toBe(1);
    let darwinPrints = 0;
    expect(
      restartHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          run: (_command, args) => {
            if (args[0] !== "print") return { status: 0, stdout: "", stderr: "" };
            darwinPrints += 1;
            return darwinPrints === 1
              ? { status: 0, stdout: "state = waiting\n", stderr: "" }
              : { status: 0, stdout: "state = running\npid = 42\n", stderr: "" };
          },
        }),
      ),
    ).toBe(0);
    let windowsHandoffs = 0;
    expect(
      restartHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
          restartHandoff: () => {
            windowsHandoffs += 1;
          },
        }),
      ),
    ).toBe(0);
    expect(windowsHandoffs).toBe(1);
    // A Linux service user cannot authorize systemctl; it must have the local handoff.
    expect(
      restartHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: seededFs(),
          run: () => ({ status: 1, stdout: "", stderr: "failed" }),
        }),
      ),
    ).toBe(1);
    // launchd's EALREADY result is not proof that a new daemon was started.
    expect(
      restartHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          run: () => ({ status: 1, stdout: "", stderr: "failed" }),
        }),
      ),
    ).toBe(1);
    expect(
      restartHostService(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          run: () => ({ status: 37, stdout: "", stderr: "already in progress" }),
        }),
      ),
    ).toBe(1);
    expect(
      restartHostService(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          run: () => ({ status: 1, stdout: "", stderr: "failed" }),
        }),
      ),
    ).toBe(1);
    expect(
      restartHostService(
        baseOpts({
          platform: "linux",
          fs: seededFs(),
          run: () => {
            throw new Error("boom");
          },
        }),
      ),
    ).toBe(1);
    expect(
      getHostServiceStatus(
        baseOpts({
          platform: "darwin",
          fs: seededFs(),
          run: () => ({ status: 0, stdout: "state = running\n", stderr: "" }),
        }),
      ),
    ).toMatchObject({ state: "running" });
    expect(
      getHostServiceStatus(
        baseOpts({
          platform: "win32",
          fs: seededFs(),
          run: () => ({ status: 0, stdout: "Status: Running\n", stderr: "" }),
        }),
      ),
    ).toMatchObject({ state: "running" });
    expect(
      getHostServiceStatus(
        baseOpts({
          platform: "linux",
          fs: seededFs(),
          run: () => {
            throw new Error("status failed");
          },
        }),
      ),
    ).toMatchObject({ state: "unknown" });
  });

  it("rejects unknown platforms and maps thrown values", () => {
    const errors: string[] = [];
    expect(
      installHostService(
        baseOpts({ platform: "aix", fs: seededFs(), error: (m) => errors.push(m) }),
      ),
    ).toBe(1);
    expect(
      uninstallHostService(
        baseOpts({ platform: "aix", fs: seededFs(), error: (m) => errors.push(m) }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/not supported/);
    expect(
      installHostService(
        baseOpts({
          platform: "linux",
          fs: memFs(),
          error: (m) => errors.push(m),
        }),
      ),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/ENOENT/);
    const uninstallErrors: string[] = [];
    expect(
      uninstallHostService(
        baseOpts({
          platform: "linux",
          uid: 0,
          fs: {
            existsSync: () => {
              throw new Error("boom");
            },
          } as unknown as HostServiceFs,
          error: (m) => uninstallErrors.push(m),
          run: () => ({ status: 0, stdout: "", stderr: "" }),
        }),
      ),
    ).toBe(1);
    expect(uninstallErrors.join("\n")).toMatch(/boom/);
  });

  it("maps a thrown restart handoff to a failed service operation", () => {
    const errors: string[] = [];
    expect(
      restartHostService(
        baseOpts({
          platform: "linux",
          fs: seededFs(),
          error: (message) => errors.push(message),
          restartHandoff: () => {
            throw new Error("handoff failed");
          },
        }),
      ),
    ).toBe(1);
    expect(errors).toEqual(["handoff failed"]);
  });

  it("stringifies non-Error throws from install and uninstall", () => {
    const errors: string[] = [];
    const throwing = {
      existsSync: () => {
        throw "nope";
      },
      readFileSync: () => {
        throw "nope";
      },
    } as unknown as HostServiceFs;
    expect(
      installHostService(
        baseOpts({ platform: "linux", fs: throwing, error: (m) => errors.push(m) }),
      ),
    ).toBe(1);
    expect(
      uninstallHostService(
        baseOpts({ platform: "linux", uid: 0, fs: throwing, error: (m) => errors.push(m) }),
      ),
    ).toBe(1);
    expect(errors).toEqual(["nope", "nope"]);
  });
});
