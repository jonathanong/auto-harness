import { spawn } from "node:child_process";

import { expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn() };
});

import { requestWindowsTaskRestart } from "./windows-task-handoff.ts";

it("uses the detached child-process handoff by default", () => {
  const child = { unref: vi.fn() };
  vi.mocked(spawn).mockReturnValueOnce(child as never);

  requestWindowsTaskRestart();

  expect(spawn).toHaveBeenCalledOnce();
  expect(child.unref).toHaveBeenCalledOnce();
});
