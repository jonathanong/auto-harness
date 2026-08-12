import { Readable } from "node:stream";

type HeaderMap = Record<string, string | undefined>;

export type HttpApiEvent = {
  body?: string | null;
  cookies?: string[];
  headers?: HeaderMap;
  isBase64Encoded?: boolean;
  rawPath?: string;
  rawQueryString?: string;
  requestContext?: { http?: { method?: string; sourceIp?: string } };
};

export type HttpApiResponse = {
  statusCode: number;
  body?: string;
  cookies?: string[];
  headers?: Record<string, string>;
};

export function eventHeaders(event: {
  headers?: HeaderMap;
  cookies?: string[];
}): Record<string, string> {
  const headers = Object.fromEntries(
    Object.entries(event.headers ?? {}).flatMap(([key, value]) =>
      value === undefined ? [] : [[key.toLowerCase(), value]],
    ),
  );
  if (event.cookies?.length) headers.cookie = event.cookies.join("; ");
  return headers;
}

export function requestForLambdaEvent(event: HttpApiEvent): import("node:http").IncomingMessage {
  const body = event.body
    ? Buffer.from(event.body, event.isBase64Encoded ? "base64" : "utf8")
    : Buffer.alloc(0);
  const request = Readable.from(body) as import("node:http").IncomingMessage;
  request.method = event.requestContext?.http?.method ?? "GET";
  request.url = `${event.rawPath ?? "/"}${event.rawQueryString ? `?${event.rawQueryString}` : ""}`;
  request.headers = eventHeaders(event);
  Object.defineProperty(request, "socket", {
    value: { remoteAddress: event.requestContext?.http?.sourceIp ?? "0.0.0.0" },
  });
  return request;
}

export function createLambdaResponseCapture(): {
  response: import("node:http").ServerResponse;
  result: () => HttpApiResponse;
} {
  let statusCode = 200;
  let body = "";
  const headers = new Map<string, string | number | readonly string[]>();
  const response = {
    setHeader(name: string, value: string | number | readonly string[]) {
      headers.set(name.toLowerCase(), value);
    },
    writeHead(status: number, next?: Record<string, string | number | readonly string[]>) {
      statusCode = status;
      for (const [name, value] of Object.entries(next ?? {}))
        headers.set(name.toLowerCase(), value);
    },
    end(value?: string | Buffer) {
      if (value) body += value.toString();
    },
  } as unknown as import("node:http").ServerResponse;
  return {
    response,
    result: () => {
      const cookies = headers.get("set-cookie");
      return {
        statusCode,
        ...(body ? { body } : {}),
        ...(cookies ? { cookies: Array.isArray(cookies) ? [...cookies] : [String(cookies)] } : {}),
        headers: Object.fromEntries(
          [...headers.entries()]
            .filter(([name]) => name !== "set-cookie")
            .map(([name, value]) => [name, Array.isArray(value) ? value.join(",") : String(value)]),
        ),
      };
    },
  };
}
