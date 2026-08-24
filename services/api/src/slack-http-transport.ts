import type {
  SlackTransport,
  SlackTransportRequest,
  SlackTransportResult,
} from "./slack-delivery-types.ts";

const SLACK_API_BASE = "https://slack.com/api";
const SLACK_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_CACHE_LIMIT = 256;

export type SlackFetcher = (
  input: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
    signal: AbortSignal;
  },
) => Promise<Pick<Response, "ok" | "status" | "headers" | "text">>;

type SlackHttpTransportOptions = {
  getBotToken: () => Promise<string | null>;
  fetch?: SlackFetcher;
  apiBase?: string;
  cacheLimit?: number;
};

/**
 * Network-backed Slack adapter. Successful deliveries are cached by operation ID so
 * an ambiguous retry after a lost lease does not post a second message in-process.
 * Overlapping deliver() calls share one in-flight request. Across Lambda invocations
 * delivery is at-least-once.
 */
export function createSlackHttpTransport(options: SlackHttpTransportOptions): SlackTransport {
  const sent = new Map<string, SlackTransportResult>();
  const inflight = new Map<string, Promise<SlackTransportResult>>();
  const fetchImpl = options.fetch ?? fetch;
  const apiBase = options.apiBase ?? SLACK_API_BASE;
  const cacheLimit = options.cacheLimit ?? DEFAULT_CACHE_LIMIT;
  return {
    async deliver(request) {
      const cached = sent.get(request.idempotencyKey);
      if (cached) {
        sent.delete(request.idempotencyKey);
        sent.set(request.idempotencyKey, cached);
        return cached;
      }
      const pending = inflight.get(request.idempotencyKey);
      if (pending) return pending;
      const work = postAndCache();
      inflight.set(request.idempotencyKey, work);
      return work;

      async function postAndCache(): Promise<SlackTransportResult> {
        try {
          const token = await options.getBotToken();
          if (!token) throw new Error("Slack bot token is unavailable");
          const result = await postToSlack(fetchImpl, apiBase, token, request);
          remember(sent, request.idempotencyKey, result, cacheLimit);
          return result;
        } finally {
          inflight.delete(request.idempotencyKey);
        }
      }
    },
  };
}

function remember(
  sent: Map<string, SlackTransportResult>,
  key: string,
  result: SlackTransportResult,
  limit: number,
): void {
  if (sent.size >= limit) {
    const oldest = sent.keys().next().value;
    if (oldest !== undefined) sent.delete(oldest);
  }
  sent.set(key, result);
}

async function postToSlack(
  fetchImpl: SlackFetcher,
  apiBase: string,
  token: string,
  request: SlackTransportRequest,
): Promise<SlackTransportResult> {
  const method = request.operation === "update-root" ? "chat.update" : "chat.postMessage";
  const response = await fetchImpl(`${apiBase}/${method}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify(slackBody(request)),
    signal: AbortSignal.timeout(SLACK_FETCH_TIMEOUT_MS),
  });
  const payload = await readSlackPayload(response);
  if (!payload.ok) {
    throw new Error(slackFailure(method, response.status, payload.error, response.headers));
  }
  if (!payload.channel || !payload.ts) {
    throw new Error(`Slack ${method} succeeded without a channel or timestamp`);
  }
  return { channel: payload.channel, messageTs: payload.ts };
}

function slackBody(request: SlackTransportRequest): Record<string, string> {
  return {
    channel: request.channel,
    text: request.text,
    ...(request.threadTs ? { thread_ts: request.threadTs } : {}),
    ...(request.messageTs ? { ts: request.messageTs } : {}),
  };
}

async function readSlackPayload(
  response: Pick<Response, "text">,
): Promise<{ ok: boolean; channel?: string; ts?: string; error?: string }> {
  const raw = await response.text();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, error: "invalid Slack response" };
    }
    const body = parsed as { ok?: unknown; channel?: unknown; ts?: unknown; error?: unknown };
    return {
      ok: body.ok === true,
      ...(typeof body.channel === "string" ? { channel: body.channel } : {}),
      ...(typeof body.ts === "string" ? { ts: body.ts } : {}),
      ...(typeof body.error === "string" ? { error: body.error } : {}),
    };
  } catch {
    return { ok: false, error: "invalid Slack response" };
  }
}

function slackFailure(
  method: string,
  status: number,
  error: string | undefined,
  headers: Pick<Headers, "get">,
): string {
  const retryAfter = headers.get("retry-after");
  if (status === 429) {
    return retryAfter
      ? `Slack ${method} rate-limited; retry after ${retryAfter}s`
      : `Slack ${method} rate-limited`;
  }
  if (error) return `Slack ${method} failed: ${error}`;
  return `Slack ${method} failed (${status})`;
}
