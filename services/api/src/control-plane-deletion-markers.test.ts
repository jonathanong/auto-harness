import { describe, expect, it } from "vitest";

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
});
