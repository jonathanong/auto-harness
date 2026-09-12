import { describe, expect, it } from "vitest";

import { commandPatchFromBody } from "./local-routes-command-patch.ts";

describe("commandPatchFromBody", () => {
  it("copies every optional command field and ignores absent ones", () => {
    expect(commandPatchFromBody({})).toEqual({});
    expect(
      commandPatchFromBody({
        name: "echo",
        argv: ["echo"],
        appendPrompt: true,
        appendPromptSeparator: false,
        providerId: null,
        resumeArgvTemplate: ["echo", "--resume"],
        resumeRefCapture: { stream: "stdout", linePrefix: "ref:" },
      }),
    ).toEqual({
      name: "echo",
      argv: ["echo"],
      appendPrompt: true,
      appendPromptSeparator: false,
      providerId: null,
      resumeArgvTemplate: ["echo", "--resume"],
      resumeRefCapture: { stream: "stdout", linePrefix: "ref:" },
    });
    expect(commandPatchFromBody({ providerId: "provider" })).toEqual({ providerId: "provider" });
    expect(commandPatchFromBody({ appendPromptSeparator: true }).appendPromptSeparator).toBe(true);
  });
});
