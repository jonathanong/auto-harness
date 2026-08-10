import type { ControlPlane, ScheduleRecord } from "./control-plane.ts";

export const BASE_COMMAND_ID = "cmd-base";

/** Unwrap putSchedule's result — throws on the (unexpected, in these tests) error path. */
export function putScheduleOrThrow(
  plane: ControlPlane,
  input: Parameters<ControlPlane["putSchedule"]>[0],
): ScheduleRecord {
  const result = plane.putSchedule(input);
  if (!result.ok) {
    throw new Error(result.error);
  }
  return result.schedule;
}

/** Seed the standalone command baseSessionBody() targets by default. */
export function seedBaseCommand(plane: ControlPlane): void {
  plane.createCommand({
    id: BASE_COMMAND_ID,
    name: "echo-prompt",
    argv: ["echo"],
    appendPrompt: true,
    providerId: null,
  });
}

export function baseSessionBody(over: Record<string, unknown> = {}) {
  return {
    repositoryId: "repo-1",
    prompt: "do work",
    target: { commandId: BASE_COMMAND_ID },
    timeout: 30,
    ...over,
  };
}
