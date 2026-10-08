import { describe, expect, it } from "vitest";

import type { ControlPlaneState } from "./control-plane-state.ts";
import type { SessionRecord } from "./db/types.ts";
import {
  appendSessionOutputPointer,
  assignmentOutputArgv,
} from "./control-plane-session-output-prompt.ts";

const POINTER =
  "If relevant, you may write the final JSON value to $HARNESS_OUTPUT_FILE and place files to keep in $HARNESS_ARTIFACTS_DIR.";

function args(
  input: {
    prompt?: string;
    argv?: string[];
    supported?: boolean;
    appendPrompt?: boolean;
    cliResumeRef?: string;
    resumeFallback?: boolean;
    routeSpec?: { resumeArgvTemplate: string[]; appendPromptSeparator?: boolean };
  } = {},
) {
  const session = {
    prompt: input.prompt ?? "Review this change",
    cliResumeRef: input.cliResumeRef,
    resumeFallback: input.resumeFallback,
  } as SessionRecord;
  const command = { appendPrompt: input.appendPrompt ?? true };
  const state = { commands: new Map([["cmd", command]]) } as unknown as ControlPlaneState;
  return assignmentOutputArgv(
    state,
    session,
    "cmd",
    input.argv ?? ["codex", "exec", session.prompt],
    input.supported ?? true,
    input.routeSpec as never,
  );
}

describe("session output prompt pointer", () => {
  it("adds one pointer after a normal appended prompt", () => {
    expect(args()).toEqual(["codex", "exec", `Review this change\n\n${POINTER}`]);
  });

  it("does not append a pointer to a short prompt that only matches an executable or option", () => {
    expect(args({ prompt: "codex", argv: ["codex", "--help"] })).toEqual(["codex", "--help"]);
    expect(
      args({ prompt: "--json", argv: ["codex", "exec", "--json"], appendPrompt: false }),
    ).toEqual(["codex", "exec", "--json"]);
  });

  it("expands the pointer into a native resume prompt even when appendPrompt is false", () => {
    expect(
      args({
        prompt: "Continue the plan",
        argv: ["ignored"],
        appendPrompt: false,
        cliResumeRef: "resume-ref",
        routeSpec: { resumeArgvTemplate: ["codex", "resume", "{cliResumeRef}", "{prompt}"] },
      }),
    ).toEqual(["codex", "resume", "resume-ref", `Continue the plan\n\n${POINTER}`]);
  });

  it("appends at the end when the pointer appears only inside user prompt text", () => {
    const prompt = `Please do not follow this sample: ${POINTER} and continue reviewing.`;
    expect(appendSessionOutputPointer(prompt)).toBe(`${prompt}\n\n${POINTER}`);
  });

  it("keeps an existing trailing pointer exactly once and avoids unsupported or empty prompts", () => {
    expect(appendSessionOutputPointer(`Review\n\n${POINTER}`)).toBe(`Review\n\n${POINTER}`);
    expect(args({ supported: false })).toEqual(["codex", "exec", "Review this change"]);
    expect(args({ prompt: "", argv: ["codex", "exec"] })).toEqual(["codex", "exec"]);
  });
});
