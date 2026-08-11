import { describe, expect, it } from "vitest";

import { updateCommandDurable } from "./control-plane-commands.ts";
import { createProviderDurable, updateProviderDurable } from "./control-plane-providers.ts";
import { createControlPlaneState } from "./control-plane-state.ts";

const now = "2026-01-01T00:00:00.000Z";

describe("catalog mutation deletion fences", () => {
  it("fences durable provider create and update with both provider and command markers", async () => {
    const state = createControlPlaneState({ now: () => now });
    const writes: Array<{ id: string; markers: unknown }> = [];
    state.storage = {
      listProviders: async () => [...state.providers.values()],
      putProvider: async (provider: { id: string }, markers: unknown) => {
        writes.push({ id: provider.id, markers });
      },
    } as never;
    await expect(
      createProviderDurable(state, {
        id: "provider",
        name: "provider",
        defaultCommandId: "command",
      }),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      updateProviderDurable(state, "provider", { defaultCommandId: "updated-command" }),
    ).resolves.toMatchObject({ ok: true });
    expect(writes).toEqual([
      {
        id: "provider",
        markers: [
          { key: "command:command", now },
          { key: "provider:provider", now },
        ],
      },
      {
        id: "provider",
        markers: [
          { key: "command:updated-command", now },
          { key: "provider:provider", now },
        ],
      },
    ]);
  });

  it("fences a durable command update with its own and provider delete markers", async () => {
    const state = createControlPlaneState({ now: () => now });
    const command = {
      id: "command",
      name: "command",
      argv: ["echo"],
      appendPrompt: true,
      providerId: "provider",
      createdAt: now,
      updatedAt: now,
    };
    state.commands.set(command.id, command);
    const writes: unknown[] = [];
    state.storage = {
      getCommand: async () => command,
      putCommand: async (_command: unknown, markers: unknown) => void writes.push(markers),
    } as never;
    await expect(
      updateCommandDurable(state, command.id, { name: "renamed" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(writes).toEqual([
      [
        { key: "command:command", now },
        { key: "provider:provider", now },
      ],
    ]);
  });
});
