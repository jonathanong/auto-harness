import { describe, expect, it } from "vitest";

import { itemToSession } from "./db/plane-storage-types.ts";
import { decodeStoredArgv, encodeStoredArgv } from "./session-argv-storage.ts";

const PROMPT = "Fix the flaky test.\nThen open a PR.";

describe("stored session argv", () => {
  it.each([
    ["an appended prompt", ["claude", "-p", PROMPT]],
    ["a prompt after a `--` separator", ["claude", "-p", "--", PROMPT]],
    ["a prompt with the output pointer appended", ["codex", "exec", `${PROMPT}\n\nIf relevant…`]],
    ["a prompt inside a resume template element", ["tool", `--message=${PROMPT}!`]],
    ["argv without the prompt", ["tool", "run"]],
  ])("round-trips %s", (_name, argv) => {
    const stored = encodeStoredArgv(argv, PROMPT);
    expect(JSON.stringify(stored)).not.toContain(JSON.stringify(PROMPT).slice(1, -1));
    expect(decodeStoredArgv(stored, PROMPT)).toEqual(argv);
  });

  it("stores the text around the prompt's first occurrence", () => {
    expect(encodeStoredArgv(["a", `x${PROMPT}y${PROMPT}`], PROMPT)).toEqual([
      "a",
      { before: "x", after: `y${PROMPT}` },
    ]);
  });

  it("keeps argv as plain strings when there is no prompt", () => {
    expect(encodeStoredArgv(["tool", ""], undefined)).toEqual(["tool", ""]);
    expect(encodeStoredArgv(["tool", ""], "")).toEqual(["tool", ""]);
    expect(decodeStoredArgv([{ before: "a", after: "b" }], undefined)).toEqual(["ab"]);
  });

  it("decodes stored argv when hydrating a Session row", () => {
    const session = itemToSession({
      id: "s-1",
      prompt: PROMPT,
      resolvedArgv: encodeStoredArgv(["claude", "-p", PROMPT], PROMPT),
    });
    expect(session.resolvedArgv).toEqual(["claude", "-p", PROMPT]);
    expect(itemToSession({ id: "s-2", prompt: PROMPT }).resolvedArgv).toBeUndefined();
  });
});
