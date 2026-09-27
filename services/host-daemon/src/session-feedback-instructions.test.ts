import { expect, it } from "vitest";
import {
  feedbackCommandArgv,
  sessionFeedbackInstructions,
} from "./session-feedback-instructions.ts";

it("inserts the reporting contract at each trusted prompt span without changing trailing options", () => {
  const argv = ["codex", "resume", "native", "first / second", "--model", "example"];
  const inserted = feedbackCommandArgv(argv, "host-owned-artifact", [
    { index: 3, start: 0, end: 5 },
    { index: 3, start: 8, end: 14 },
  ]);
  const contract = sessionFeedbackInstructions("host-owned-artifact");
  expect(inserted[3]).toBe(`first${contract} / second${contract}`);
  expect(inserted.slice(4)).toEqual(argv.slice(4));
  expect(argv[3]).toBe("first / second");
  expect(contract).toContain("applicable workflow tool");
  expect(contract).toContain("architecture/sandbox/tools scope or reason");
});

it("ignores malformed or over-budget bindings rather than corrupting provider argv", () => {
  const argv = ["codex", "exec", "prompt"];
  const invalid = [
    { index: 0, start: 0, end: 1 },
    { index: 3, start: 0, end: 1 },
    { index: 2.5, start: 0, end: 1 },
    { index: 2, start: -1, end: 1 },
    { index: 2, start: 2, end: 1 },
    { index: 2, start: 0, end: 7 },
    { index: 2, start: 0.5, end: 1 },
    { index: 2, start: 0, end: 1.5 },
  ];
  for (const binding of invalid)
    expect(feedbackCommandArgv(argv, "host-owned", [binding])).toEqual(argv);
  expect(feedbackCommandArgv(argv, "host-owned", Array(17).fill(invalid[0]))).toEqual(argv);
  expect(feedbackCommandArgv([], "host-owned")).toEqual([]);
  expect(feedbackCommandArgv(["custom", "prompt"], "host-owned", [invalid[0]!])).toEqual([
    "custom",
    "prompt",
  ]);
});
