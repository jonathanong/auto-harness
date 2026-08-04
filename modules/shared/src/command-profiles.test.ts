import { describe, expect, it } from "vitest";

import { removeCommandProfile, setCommandProfile } from "./command-profiles.ts";
import { emptyHostInventory } from "./host-inventory.ts";

describe("setCommandProfile / removeCommandProfile", () => {
  it("adds a new profile without disturbing existing ones", () => {
    const inv = emptyHostInventory();
    const next = setCommandProfile(inv, "build", { argv: ["make"], appendPrompt: false });
    expect(next.commandProfiles["build"]).toEqual({ argv: ["make"], appendPrompt: false });
    expect(next.commandProfiles["echo-prompt"]).toEqual(inv.commandProfiles["echo-prompt"]);
    expect(inv.commandProfiles["build"]).toBeUndefined();
  });

  it("replaces an existing profile by name", () => {
    const inv = setCommandProfile(emptyHostInventory(), "echo-prompt", {
      argv: ["echo", "-n"],
      appendPrompt: true,
    });
    expect(inv.commandProfiles["echo-prompt"]?.argv).toEqual(["echo", "-n"]);
  });

  it("removes a profile by name, leaving others intact", () => {
    let inv = setCommandProfile(emptyHostInventory(), "build", {
      argv: ["make"],
      appendPrompt: false,
    });
    inv = removeCommandProfile(inv, "build");
    expect(inv.commandProfiles["build"]).toBeUndefined();
    expect(inv.commandProfiles["echo-prompt"]).toBeDefined();
  });

  it("removing an unknown profile is a no-op", () => {
    const inv = emptyHostInventory();
    const next = removeCommandProfile(inv, "missing");
    expect(next.commandProfiles).toEqual(inv.commandProfiles);
  });
});
