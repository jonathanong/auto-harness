import { expect, type APIRequestContext } from "@playwright/test";

type AssignedSession = { status: "running"; attemptId: string; worktreeId: string };

/** Admission and the bounded scheduler may need another tick behind earlier queued work. */
export async function waitForAssignment(
  request: APIRequestContext,
  api: string,
  sessionId: string,
): Promise<AssignedSession> {
  let session: AssignedSession | undefined;
  await expect
    .poll(async () => {
      const scheduled = await request.post(`${api}/api/v1/scheduler/assign`);
      expect(scheduled.ok()).toBe(true);
      const response = await request.get(`${api}/api/v1/sessions/${sessionId}`);
      expect(response.ok()).toBe(true);
      const result = (await response.json()) as Partial<AssignedSession>;
      if (
        result.status === "running" &&
        typeof result.attemptId === "string" &&
        typeof result.worktreeId === "string"
      ) {
        session = result as AssignedSession;
      }
      return session !== undefined;
    })
    .toBe(true);
  return session!;
}
