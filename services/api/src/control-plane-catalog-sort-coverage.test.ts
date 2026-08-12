import { expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";

it("uses ids as deterministic catalog sort tie breakers", () => {
  const plane = new ControlPlane();
  const timestamps = { createdAt: "now", updatedAt: "now" };
  plane.state.commands.set("b", {
    id: "b",
    name: "same",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    ...timestamps,
  });
  plane.state.commands.set("a", {
    id: "a",
    name: "same",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
    ...timestamps,
  });
  plane.state.providers.set("b", {
    id: "b",
    name: "same",
    defaultCommandId: null,
    ...timestamps,
  });
  plane.state.providers.set("a", {
    id: "a",
    name: "same",
    defaultCommandId: null,
    ...timestamps,
  });
  plane.state.repositories.set("b", {
    id: "b",
    name: "same",
    url: "/b",
    defaultBranch: "main",
    ...timestamps,
  });
  plane.state.repositories.set("a", {
    id: "a",
    name: "same",
    url: "/a",
    defaultBranch: "main",
    ...timestamps,
  });

  expect(plane.listCommands().map(({ id }) => id)).toEqual(["a", "b"]);
  expect(plane.listProviders().map(({ id }) => id)).toEqual(["a", "b"]);
  expect(plane.listRepositories().map(({ id }) => id)).toEqual(["a", "b"]);
});
