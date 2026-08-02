import { describe, expect, it } from "vitest";

import { resolveCommandArgv, UnknownCommandProfileError } from "./command-profiles.js";

describe("resolveCommandArgv", () => {
  it("appends prompt when configured", () => {
    expect(
      resolveCommandArgv(
        { "echo-prompt": { argv: ["echo"], appendPrompt: true } },
        "echo-prompt",
        "hello world",
      ),
    ).toEqual(["echo", "hello world"]);
  });

  it("omits prompt when appendPrompt is false", () => {
    expect(
      resolveCommandArgv({ true: { argv: ["true"], appendPrompt: false } }, "true", "ignored"),
    ).toEqual(["true"]);
  });

  it("rejects unknown profiles and empty argv", () => {
    expect(() => resolveCommandArgv({}, "missing", "p")).toThrow(UnknownCommandProfileError);
    expect(() => resolveCommandArgv({ x: { argv: [], appendPrompt: true } }, "x", "p")).toThrow(
      UnknownCommandProfileError,
    );
  });
});
