import { describe, expect, it } from "vitest";

import { DEFAULT_SESSION_LOG_SETTINGS } from "@auto-harness/shared";

import { ControlPlane } from "./control-plane.ts";
import { assignLogSettings } from "./control-plane-session-log-settings.ts";

describe("session log settings", () => {
  it("returns defaults with version 0 when nothing is stored", async () => {
    const plane = new ControlPlane();
    await expect(plane.getSessionLogSettings()).resolves.toEqual({
      ...DEFAULT_SESSION_LOG_SETTINGS,
      version: 0,
    });
    expect(assignLogSettings(plane.state)).toEqual(DEFAULT_SESSION_LOG_SETTINGS);
  });

  it("upserts with compare-and-swap versioning", async () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    const created = await plane.putSessionLogSettings({ version: 0, uploadMode: "always" });
    expect(created).toMatchObject({
      ok: true,
      settings: { uploadMode: "always", version: 1 },
    });
    await expect(
      plane.putSessionLogSettings({ version: 0, uploadMode: "subscribed" }),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    const updated = await plane.putSessionLogSettings({
      version: 1,
      uploadMode: "subscribed",
      batchMaxKb: 64,
    });
    expect(updated).toMatchObject({
      ok: true,
      settings: { uploadMode: "subscribed", batchMaxKb: 64, version: 2 },
    });
  });

  it("preserves omitted knobs on a partial update", async () => {
    const plane = new ControlPlane();
    await plane.putSessionLogSettings({ version: 0, uploadMode: "always", batchMaxLines: 12 });
    const updated = await plane.putSessionLogSettings({ version: 1, uploadMode: "subscribed" });
    expect(updated).toMatchObject({
      ok: true,
      settings: { uploadMode: "subscribed", batchMaxLines: 12 },
    });
  });

  it("reads and writes through durable storage and rejects a lost CAS", async () => {
    let stored: { version: number; uploadMode: string; createdAt: string } | null = null;
    let acceptWrite = true;
    const plane = new ControlPlane({
      now: () => "2026-01-01T00:00:00.000Z",
      storage: {
        getSessionLogSettings: async () => stored,
        putSessionLogSettings: async (record: { version: number; uploadMode: string }) => {
          if (!acceptWrite) return false;
          stored = {
            version: record.version,
            uploadMode: record.uploadMode,
            createdAt: "2026-01-01T00:00:00.000Z",
          };
          return true;
        },
      } as never,
    });
    expect((await plane.getSessionLogSettings()).version).toBe(0);
    expect((await plane.putSessionLogSettings({ version: -1 })).ok).toBe(false);
    expect((await plane.putSessionLogSettings({ version: 0, uploadMode: "always" })).ok).toBe(true);
    acceptWrite = false;
    await expect(
      plane.putSessionLogSettings({ version: 1, uploadMode: "off" }),
    ).resolves.toMatchObject({ ok: false, conflict: true });
  });
});
