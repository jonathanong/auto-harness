import { describe, expect, it } from "vitest";

import { ControlPlane } from "./control-plane.ts";
import { putScheduleOrThrow, seedBaseCommand } from "./control-plane-test-helpers.ts";
import {
  applyStoredPrompt,
  scheduledSessionPrompt,
  storedSchedulePrompt,
} from "./control-plane-schedule-prompt.ts";

describe("scheduledSessionPrompt", () => {
  it("uses an explicit stored prompt", () => {
    expect(scheduledSessionPrompt({ prompt: "  review the repo  " })).toBe("review the repo");
  });

  it("does not invent scheduled:<name> when the prompt is missing or blank", () => {
    expect(scheduledSessionPrompt({ prompt: undefined })).toBe("");
    expect(scheduledSessionPrompt({ prompt: "   " })).toBe("");
    expect(scheduledSessionPrompt({})).toBe("");
    expect(scheduledSessionPrompt({ prompt: "scheduled:qa-prod-hourly" })).toBe(
      "scheduled:qa-prod-hourly",
    );
  });
});

describe("storedSchedulePrompt", () => {
  it("trims a real prompt and omits blank values", () => {
    expect(storedSchedulePrompt("  lint the tree  ")).toBe("lint the tree");
    expect(storedSchedulePrompt("")).toBeUndefined();
    expect(storedSchedulePrompt("   ")).toBeUndefined();
    expect(storedSchedulePrompt(undefined)).toBeUndefined();
  });
});

describe("applyStoredPrompt", () => {
  it("sets a trimmed prompt and clears a blank one", () => {
    const record: { prompt?: string } = { prompt: "old" };
    applyStoredPrompt(record, "  new work  ");
    expect(record.prompt).toBe("new work");
    applyStoredPrompt(record, "  ");
    expect(record).not.toHaveProperty("prompt");
  });
});

describe("scheduled session prompt on fire", () => {
  it("uses the stored prompt and does not invent scheduled:<name>", () => {
    const plane = new ControlPlane({ now: () => "2026-01-01T00:00:00.000Z" });
    seedBaseCommand(plane);
    const withPrompt = putScheduleOrThrow(plane, {
      id: "with-prompt",
      repositoryId: "repo-1",
      name: "qa-prod-hourly",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
      prompt: "  review the repo  ",
    });
    expect(withPrompt.prompt).toBe("review the repo");
    expect(plane.triggerSchedule(withPrompt.id)).toMatchObject({
      ok: true,
      session: { prompt: "review the repo" },
    });
    const blank = putScheduleOrThrow(plane, {
      id: "blank-prompt",
      repositoryId: "repo-1",
      name: "qa-prod-hourly",
      target: { commandId: "cmd-base" },
      cron: "* * * * *",
      timeout: 1,
      prompt: "   ",
    });
    expect(blank).not.toHaveProperty("prompt");
    expect(plane.triggerSchedule(blank.id)).toMatchObject({
      ok: true,
      session: { prompt: "" },
    });
    const cleared = plane.updateSchedule(withPrompt.id, { prompt: "  " });
    expect(cleared.ok).toBe(true);
    if (cleared.ok) expect(cleared.schedule).not.toHaveProperty("prompt");
  });
});
