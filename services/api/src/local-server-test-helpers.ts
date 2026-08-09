/** Shared HTTP invoke fake for local-server unit tests. */
export async function invokeHandler(
  handler: (req: never, res: never) => void | Promise<void>,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; raw: string }> {
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
  return { status: statusCode, raw, json };
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
