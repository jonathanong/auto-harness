import { expect } from "vitest";

import type { LogRecord } from "../services/api/src/control-plane-types.ts";
import { filamentsResumeSessionBody } from "./filaments-session-contract.ts";

type JsonRequest = <T>(
  base: string,
  path: string,
  expectedStatus: number,
  init?: RequestInit,
) => Promise<T>;

export async function expectFilamentsSessionOutput(input: {
  base: string;
  jsonRequest: JsonRequest;
  sessionId: string;
}) {
  const logs = await input.jsonRequest<{ items: LogRecord[] }>(
    input.base,
    `/api/v1/sessions/${input.sessionId}/logs`,
    200,
  );
  expect(logs.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        stream: "stdout",
        content: expect.stringContaining("durable-full-stack-output"),
      }),
      expect.objectContaining({ stream: "system", content: "Process exited with code 0" }),
    ]),
  );
}

export async function expectDurableFilamentsSource(input: {
  base: string;
  jsonRequest: JsonRequest;
  sessionId: string;
}) {
  const session = await input.jsonRequest<{ exitCode: number | null; status: string }>(
    input.base,
    `/api/v1/sessions/${input.sessionId}`,
    200,
  );
  expect(session).toMatchObject({ status: "completed", exitCode: 0 });
  await expectFilamentsSessionOutput(input);
}

export async function exerciseFilamentsResume(input: {
  base: string;
  jsonRequest: JsonRequest;
  sourceSessionId: string;
  waitForTerminal: (base: string, sessionId: string) => Promise<{ status: string }>;
}) {
  const source = await input.jsonRequest<{
    concurrencyId: string;
    metadata: Record<string, unknown>;
    priority: number;
    ref: string;
    requiredLabels: string[];
    source: string;
  }>(input.base, `/api/v1/sessions/${input.sourceSessionId}`, 200);
  expect(source).toMatchObject({
    concurrencyId: "filaments-durable-integration",
    metadata: { issueNumber: 9366, repository: "jonathanong/filaments" },
    priority: 20,
    ref: "refs/heads/main",
    requiredLabels: ["filaments"],
    source: "webhook",
  });

  const resumed = await input.jsonRequest<{
    created: boolean;
    id: string;
    metadata: Record<string, unknown>;
    priority: number;
    prompt: string;
    resumedFromSessionId: string;
    source: string;
  }>(input.base, `/api/v1/sessions/${input.sourceSessionId}/resume`, 201, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(
      filamentsResumeSessionBody("Continue the Filaments dispatch", source.concurrencyId),
    ),
  });
  expect(resumed).toMatchObject({
    created: true,
    metadata: { issueNumber: 9366, repository: "jonathanong/filaments" },
    priority: 21,
    prompt: "Continue the Filaments dispatch",
    resumedFromSessionId: input.sourceSessionId,
    source: "api",
  });
  expect(resumed.id).not.toBe(input.sourceSessionId);
  expect((await input.waitForTerminal(input.base, resumed.id)).status).toBe("completed");
  return resumed.id;
}

export async function expectDurableFilamentsResume(input: {
  base: string;
  jsonRequest: JsonRequest;
  resumedSessionId: string;
  sourceSessionId: string;
}) {
  const resumed = await input.jsonRequest<{
    exitCode: number | null;
    resumedFromSessionId: string;
    status: string;
  }>(input.base, `/api/v1/sessions/${input.resumedSessionId}`, 200);
  expect(resumed).toMatchObject({
    exitCode: 0,
    resumedFromSessionId: input.sourceSessionId,
    status: "completed",
  });
}
