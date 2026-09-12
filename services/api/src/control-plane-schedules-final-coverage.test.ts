import { expect, it } from "vitest";

import { putScheduleDurable } from "./control-plane-schedules.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

it("rejects durable schedule creation for a repository absent from the local durable read model", async () => {
  const state = createControlPlaneState({ now: () => "2026-01-01T00:00:00.000Z" });
  state.commands.set("command", {
    id: "command",
    name: "command",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });

  await expect(
    putScheduleDurable(state, {
      repositoryId: "removed-repository",
      name: "nightly",
      target: { commandId: "command" },
      cron: "* * * * *",
      timeout: 30,
    }),
  ).resolves.toEqual({ ok: false, error: "repository not found" });
});
