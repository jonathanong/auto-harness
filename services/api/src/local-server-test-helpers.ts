import { AuthService } from "./auth.ts";
import { ControlPlane } from "./control-plane.ts";
import { createLocalApp } from "./local-server.ts";

function base64Admins(): string {
  return Buffer.from(JSON.stringify([{ username: "root", password: "root" }])).toString(
    "base64url",
  );
}

/**
 * A ControlPlane + local HTTP app wired with one repo ("repo"), one command
 * ("command"), and one author service account per name in `accountNames`.
 * Shared by session-resume route tests to avoid re-deriving this fixture.
 */
export async function createResumeRouteFixture(
  accountNames: readonly string[] = ["automation"],
): Promise<{
  plane: ControlPlane;
  accounts: Array<Awaited<ReturnType<AuthService["createServiceAccount"]>>>;
  invoke: (path: string, body: unknown, apiKey: string) => ReturnType<typeof invokeHandler>;
}> {
  const plane = new ControlPlane({
    idFactory: (() => {
      let id = 0;
      return () => `session-${++id}`;
    })(),
  });
  plane.createRepository({ id: "repo", name: "repo", url: "https://example.test/repo" });
  plane.createCommand({ id: "command", name: "command", argv: ["echo"], providerId: null });
  const auth = new AuthService({
    mode: "required",
    secret: "a".repeat(32),
    admins: base64Admins(),
  });
  const accounts = await Promise.all(
    accountNames.map((name) =>
      auth.createServiceAccount({ name, role: "author", allowedRepositoryIds: ["repo"] }),
    ),
  );
  const { handler } = createLocalApp({
    plane,
    authService: auth,
    rateLimitConfig: { enabled: false },
  });
  const invoke = (path: string, body: unknown, apiKey: string) =>
    invokeHandler(handler, "POST", path, body, { authorization: `Bearer ${apiKey}` });
  return { plane, accounts, invoke };
}

/** Shared HTTP invoke fake for local-server unit tests. */
export async function invokeHandler(
  handler: (req: never, res: never) => void | Promise<void>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{
  status: number;
  json: unknown;
  raw: string;
  headers: ReadonlyMap<string, string | number | string[]>;
}> {
  const chunks: Buffer[] = [];
  let statusCode = 0;
  const req = {
    method,
    url: path,
    headers,
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data" && body !== undefined) {
        cb(Buffer.from(JSON.stringify(body)));
      }
      if (event === "end") {
        cb();
      }
      return req;
    },
  };
  const responseHeaders = new Map<string, string | number | string[]>();
  const res = {
    setHeader(name: string, value: string | number | string[]) {
      responseHeaders.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return responseHeaders.get(name.toLowerCase());
    },
    writeHead(code: number) {
      statusCode = code;
    },
    end(payload?: string) {
      if (payload) {
        chunks.push(Buffer.from(payload));
      }
    },
  };
  await handler(req as never, res as never);
  const raw = Buffer.concat(chunks).toString("utf8");
  let json: unknown = null;
  if (raw) {
    try {
      json = JSON.parse(raw) as unknown;
    } catch {
      json = raw;
    }
  }
  return { status: statusCode, raw, json, headers: responseHeaders };
}

export async function invokeBadJson(
  handler: (req: never, res: never) => void | Promise<void>,
  method: string,
  path: string,
): Promise<number> {
  let status = 0;
  const req = {
    method,
    url: path,
    headers: {},
    on(event: string, cb: (...args: unknown[]) => void) {
      if (event === "data") {
        cb(Buffer.from("{bad"));
      }
      if (event === "end") {
        cb();
      }
      return req;
    },
  };
  const res = {
    setHeader() {
      /* cors / content-type */
    },
    writeHead(code: number) {
      status = code;
    },
    end() {
      /* empty */
    },
  };
  await handler(req as never, res as never);
  return status;
}
