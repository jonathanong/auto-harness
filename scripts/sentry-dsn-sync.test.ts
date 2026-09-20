import { describe, expect, it } from "vitest";

import { renderedDsnExports } from "./sentry-dsn-sync.ts";

const dsn = (project: string) => `https://public@o1.ingest.sentry.io/${project}`;

describe("renderedDsnExports", () => {
  it("maps one selected environment's public DSNs to every runtime consumer", () => {
    expect(
      renderedDsnExports("staging", {
        staging: {
          "auto-harness-control-plane-lambda": dsn("1"),
          "auto-harness-control-plane-web": dsn("2"),
          "auto-harness-host-plane-backend": dsn("3"),
          "auto-harness-host-plane-web": dsn("4"),
        },
      }),
    ).toEqual([
      `export HARNESS_API_SENTRY_DSN='${dsn("1")}';`,
      `export HARNESS_WEB_SENTRY_DSN_CLIENT='${dsn("2")}';`,
      `export HARNESS_WEB_SENTRY_DSN_SERVER='${dsn("2")}';`,
      `export HARNESS_HOST_SENTRY_DSN='${dsn("3")}';`,
      `export HARNESS_HOST_PANE_SENTRY_DSN_CLIENT='${dsn("4")}';`,
      `export HARNESS_HOST_PANE_SENTRY_DSN_SERVER='${dsn("4")}';`,
      "export HARNESS_DEPLOY_ENVIRONMENT='staging';",
      "export HARNESS_SENTRY_ENABLED='1';",
    ]);
  });

  it("rejects incomplete or non-public Sentry output rather than emitting partial config", () => {
    expect(() => renderedDsnExports("production", {})).toThrow("production");
    expect(() =>
      renderedDsnExports("staging", {
        staging: { "auto-harness-control-plane-lambda": "not-a-dsn" },
      }),
    ).toThrow("public Sentry DSN");
  });
});
