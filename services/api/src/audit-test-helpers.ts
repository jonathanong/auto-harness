import { ControlPlane } from "./control-plane.ts";
import { handleRepositoryRoutes } from "./local-routes-repos-schedules.ts";

export function admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

export function basic(username: string, password: string): Record<string, string> {
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

export function auditFixture(): ControlPlane {
  const plane = new ControlPlane({
    idFactory: () => "session-a",
    scheduleIdFactory: () => "schedule-a",
    repositoryIdFactory: () => "repository-a",
    providerIdFactory: () => "provider-a",
    providerAccountIdFactory: () => "account-a",
    commandIdFactory: () => "command-a",
  });
  if (!plane.createProvider({ id: "provider-a", name: "provider" }).ok) throw new Error("provider");
  if (
    !plane.createCommand({
      id: "command-a",
      name: "command",
      argv: ["tool"],
      providerId: "provider-a",
    }).ok
  )
    throw new Error("command");
  if (
    !plane.createProviderAccount({ id: "account-a", providerId: "provider-a", label: "account" }).ok
  )
    throw new Error("provider account");
  if (
    !plane.createRepository({
      id: "repository-a",
      name: "repository",
      url: "https://example.test/repository.git",
    }).ok
  )
    throw new Error("repository");
  if (
    !plane.putSchedule({
      id: "schedule-a",
      repositoryId: "repository-a",
      name: "schedule",
      target: { commandId: "command-a" },
      cron: "* * * * *",
      timeout: 60,
      nextRunAt: "2026-08-10T00:00:00.000Z",
    }).ok
  )
    throw new Error("schedule");
  if (
    !plane.createSession({
      id: "session-a",
      repositoryId: "repository-a",
      target: { commandId: "command-a" },
      prompt: "safe",
      timeout: 60,
    }).ok
  )
    throw new Error("session");
  return plane;
}

export async function invokeRepositoryRoute(
  plane: ControlPlane,
  method: "PATCH" | "DELETE",
  path: string,
  body: unknown,
): Promise<number> {
  let status = 0;
  const req = {
    on(event: string, callback: (chunk?: Buffer) => void) {
      if (event === "data") callback(Buffer.from(JSON.stringify(body)));
      if (event === "end") callback();
      return req;
    },
  };
  const res = {
    setHeader() {},
    writeHead(code: number) {
      status = code;
    },
    end() {},
  };
  await handleRepositoryRoutes({
    plane,
    req: req as never,
    res: res as never,
    url: new URL(path, "http://localhost"),
    method,
    principal: {
      id: "user:scoped",
      kind: "service-account",
      role: "admin",
      allowedRepositoryIds: ["other"],
    },
  });
  return status;
}
