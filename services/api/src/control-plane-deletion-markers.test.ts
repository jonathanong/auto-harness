import { describe, expect, it, vi } from "vitest";

import { withDeletionMarkers } from "./control-plane-deletion-markers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

describe("catalog deletion markers", () => {
  it("is a no-op without durable marker support", async () => {
    const state = createControlPlaneState();
    await expect(
      withDeletionMarkers(state, ["repository:repo"], async () => ({ ok: true })),
    ).resolves.toEqual({ ok: true });
    state.storage = {} as never;
    await expect(
      withDeletionMarkers(state, ["repository:repo"], async () => ({ ok: true })),
    ).resolves.toEqual({ ok: true });
  });

  it("releases acquired keys and returns a retryable conflict for a busy marker", async () => {
    const released: string[] = [];
    const state = createControlPlaneState({ now: () => "now" });
    state.storage = {
      acquireDeletionMarker: async (key: string) => key !== "repository:busy",
      releaseDeletionMarker: async (key: string) => {
        released.push(key);
      },
    } as never;
    await expect(
      withDeletionMarkers(state, ["repository:busy"], async () => ({ ok: true })),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    await expect(
      withDeletionMarkers(state, ["command:c", "repository:r", "command:c"], async () => ({
        ok: true,
      })),
    ).resolves.toEqual({ ok: true });
    expect(released).toEqual(["command:c", "repository:r"]);
  });

  it("releases a partial acquisition when a later sorted marker is busy", async () => {
    const released: string[] = [];
    const state = createControlPlaneState();
    state.storage = {
      acquireDeletionMarker: async (key: string) => key !== "repository:r",
      releaseDeletionMarker: async (key: string) => {
        released.push(key);
      },
    } as never;
    await expect(
      withDeletionMarkers(state, ["repository:r", "command:c"], async () => ({ ok: true })),
    ).resolves.toMatchObject({ ok: false, conflict: true });
    expect(released).toEqual(["command:c"]);
  });

  it("renews every owned marker until the operation completes", async () => {
    vi.useFakeTimers();
    try {
      const renewed: string[] = [];
      const released: string[] = [];
      const state = createControlPlaneState();
      state.storage = {
        acquireDeletionMarker: async () => true,
        renewDeletionMarker: async (key: string) => {
          renewed.push(key);
          return true;
        },
        releaseDeletionMarker: async (key: string) => {
          released.push(key);
        },
      } as never;
      let finish: (() => void) | undefined;
      const done = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const operation = withDeletionMarkers(state, ["repository:r", "command:c"], async () => {
        await done;
        return { ok: true };
      });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(renewed).toEqual(["command:c", "repository:r"]);
      finish!();
      await expect(operation).resolves.toEqual({ ok: true });
      expect(released).toEqual(["command:c", "repository:r"]);
    } finally {
      vi.useRealTimers();
    }
  });
});
