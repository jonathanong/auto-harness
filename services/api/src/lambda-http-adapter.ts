import { isIP } from "node:net";
import { Readable } from "node:stream";

type HeaderMap = Record<string, string | undefined>;

/** CloudFront-generated address and source port, forwarded only on the protected API origin. */
const CLOUDFRONT_VIEWER_ADDRESS_HEADER = "cloudfront-viewer-address";

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
  const headers = eventHeaders(event);
  request.headers = headers;
  // The HTTP API invokes this Lambda only after the ingress authorizer accepts
  // CloudFront's secret origin header. CloudFront itself produces this header
  // from the viewer connection, so a direct API Gateway caller cannot choose
  // this key: it cannot reach this handler without that origin credential.
  const sourceIp =
    cloudFrontViewerIp(headers[CLOUDFRONT_VIEWER_ADDRESS_HEADER]) ??
    event.requestContext?.http?.sourceIp ??
    "0.0.0.0";
  Object.defineProperty(request, "socket", {
    value: { remoteAddress: sourceIp },
  });
  return request;
}

function cloudFrontViewerIp(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const bracketed = /^\[([^\]]+)\]:\d+$/.exec(value);
  if (bracketed && isIP(bracketed[1]!)) return bracketed[1];
  const addressWithPort = /^(.*):\d+$/.exec(value);
  return addressWithPort && isIP(addressWithPort[1]!) ? addressWithPort[1] : undefined;
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
