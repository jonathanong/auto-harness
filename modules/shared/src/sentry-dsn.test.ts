import { describe, expect, it } from "vitest";

import {
  inspectSentryDsn,
  optionalSentryDsn,
  parseSentryDsn,
  scrubSentryEvent,
  sentryIngestEnvelopeUrl,
} from "./sentry-dsn.ts";

const dsn = "https://abc123@o1.ingest.sentry.io/450";

describe("inspectSentryDsn / optionalSentryDsn", () => {
  it("treats missing, blank, and placeholder values as unset", () => {
    for (const value of [undefined, "", "  ", "REPLACE_WITH_DSN", "<dsn>", "${SENTRY_DSN}"]) {
      expect(inspectSentryDsn(value)).toEqual({ kind: "unset" });
      expect(optionalSentryDsn(value)).toBeUndefined();
    }
  });

  it("rejects values that are not Sentry DSNs", () => {
    for (const value of [
      "not-a-url",
      "https://ingest.sentry.io/450",
      "https://abc123@o1.ingest.sentry.io/",
      "https://abc123:secret@o1.ingest.sentry.io/450",
      "ftp://abc123@o1.ingest.sentry.io/450",
      "https://abc123@o1.ingest.sentry.io/450?x=1",
    ]) {
      expect(inspectSentryDsn(value)).toEqual({ kind: "invalid" });
      expect(optionalSentryDsn(value)).toBeUndefined();
    }
  });

  it("accepts a public-key DSN", () => {
    expect(inspectSentryDsn(` ${dsn} `)).toEqual({
      kind: "ok",
      dsn,
      parts: {
        dsn,
        host: "o1.ingest.sentry.io",
        pathPrefix: "",
        projectId: "450",
        protocol: "https:",
        publicKey: "abc123",
      },
    });
    expect(optionalSentryDsn(` ${dsn} `)).toBe(dsn);
  });
});

describe("parseSentryDsn / sentryIngestEnvelopeUrl", () => {
  it("builds the envelope ingest URL including a self-hosted path prefix", () => {
    expect(sentryIngestEnvelopeUrl(dsn)).toBe("https://o1.ingest.sentry.io/api/450/envelope/");
    expect(sentryIngestEnvelopeUrl("http://key@sentry.example.test/foo/9")).toBe(
      "http://sentry.example.test/foo/api/9/envelope/",
    );
    expect(parseSentryDsn("https://o1.ingest.sentry.io/450")).toBeUndefined();
    expect(sentryIngestEnvelopeUrl("not-a-dsn")).toBeUndefined();
  });
});

describe("scrubSentryEvent", () => {
  it("removes cookie and authorization headers and leaves other payloads alone", () => {
    expect(scrubSentryEvent(null)).toBeNull();
    expect(scrubSentryEvent("x")).toBe("x");
    const event = {
      request: {
        headers: {
          Cookie: "session=1",
          authorization: "Bearer z",
          "Content-Type": "application/json",
        },
      },
    };
    expect(scrubSentryEvent(event).request.headers).toEqual({ "Content-Type": "application/json" });
    expect(scrubSentryEvent({ request: {} })).toEqual({ request: {} });
  });
});
