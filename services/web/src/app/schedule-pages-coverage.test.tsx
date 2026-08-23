/* eslint-disable max-lines -- schedule route states share one API fixture. */
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import ScheduleDetailPage from "./schedules/[id]/page.tsx";
import SchedulesPage from "./schedules/page.tsx";
import { jsonResponse, renderPage, stubApi } from "./route-test-helpers.tsx";

const writablePrincipal = {
  id: "admin-1",
  username: "admin",
  role: "admin",
  kind: "admin",
};

const readonlyPrincipal = {
  id: "viewer-1",
  username: "viewer",
  role: "read-only",
  kind: "user",
  capabilities: [],
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("schedule pages", () => {
  it("renders the complete editable schedule list and preserves a removed repository", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "required");
    stubApi({
      "/api/v1/auth/me": writablePrincipal,
      "/api/v1/schedules": {
        items: [
          {
            id: "schedule/one",
            name: "Nightly",
            repositoryId: "removed-repo",
            targetLabels: ["Claude", "review"],
            target: { providerId: "provider-1" },
            fallbacks: [{ providerId: "provider-2" }, { commandId: "command-1" }],
            cron: "0 2 * * *",
            enabled: true,
            timeout: 900,
            queueTtlSeconds: 120,
            nextRunAt: "2026-08-24T02:00:00.000Z",
            lastRunAt: "2026-08-23T02:00:00.000Z",
            concurrencyId: "nightly-main",
            activeSessionId: "session/active",
          },
        ],
      },
      "/api/v1/session-targets": { items: [{ id: "target-1", label: "Claude" }] },
      "/api/v1/repositories": {
        items: [
          { id: "repo-2", name: "Zebra" },
          { id: "repo-1", name: "Harness" },
        ],
      },
    });

    const html = await renderPage(
      SchedulesPage({ searchParams: Promise.resolve({ edit: "schedule/one" }) }),
    );
    expect(html).toContain('data-pw="schedule-row-schedule/one"');
    expect(html).toContain('href="/schedules/schedule%2Fone"');
    expect(html).toContain("Claude → review");
    expect(html).toContain("2 fallbacks");
    expect(html).toContain("120s");
    expect(html).toContain("nightly-main");
    expect(html).toContain('href="/sessions/session%2Factive"');
    expect(html).toContain("Edit Nightly");
    expect(html).toContain("removed-repo");
    expect(html.indexOf("Harness")).toBeLessThan(html.indexOf("Zebra"));
  });

  it("renders read-only defaults without authoring controls", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "required");
    stubApi({
      "/api/v1/auth/me": readonlyPrincipal,
      "/api/v1/schedules": {
        items: [
          {
            id: "schedule-2",
            name: "Disabled",
            repositoryId: "repo-2",
            target: { providerId: "provider-2" },
            cron: "@daily",
            enabled: false,
            timeout: 60,
            nextRunAt: "tomorrow",
            lastRunAt: null,
          },
          {
            id: "schedule-3",
            name: "Fallback",
            repositoryId: "repo-3",
            target: {},
            fallbacks: [{ commandId: "command-1" }],
            cron: "@hourly",
            enabled: true,
            timeout: 60,
            nextRunAt: "later",
            lastRunAt: null,
          },
        ],
      },
      "/api/v1/session-targets": {},
      "/api/v1/repositories": {},
    });

    const html = await renderPage(
      SchedulesPage({ searchParams: Promise.resolve({ edit: ["schedule-2"] }) }),
    );
    expect(html).toContain("provider-2");
    expect(html).toContain("691200s");
    expect(html).toContain("disabled");
    expect(html).toContain("enabled");
    expect(html).toContain("1 fallback");
    expect(html).toContain("—");
    expect(html).not.toContain("Add schedule");
    expect(html).not.toContain('data-pw="schedule-edit-schedule-2"');
  });

  it("renders the writable empty state when authentication is disabled", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "disabled");
    stubApi({
      "/api/v1/schedules": {},
      "/api/v1/session-targets": {},
      "/api/v1/repositories": {},
    });
    const html = await renderPage(SchedulesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("No schedules configured.");
    expect(html).toContain('data-pw="schedules-empty-create"');
    expect(html).toContain("Add schedule");
  });

  it("renders schedule detail, history, and writable controls", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "required");
    stubApi({
      "/api/v1/auth/me": writablePrincipal,
      "/api/v1/schedules/schedule%2Fone": {
        id: "schedule/one",
        name: "Nightly",
        repositoryId: "repo-1",
        target: { commandId: "command-1" },
        fallbacks: [],
        cron: "0 2 * * *",
        enabled: true,
        timeout: 900,
        queueTtlSeconds: 120,
        nextRunAt: "tomorrow",
        lastRunAt: null,
        concurrencyId: "nightly-main",
        activeSessionId: "session/active",
      },
      "/api/v1/session-targets": {},
      "/api/v1/sessions?scheduleId=schedule%2Fone&limit=100": {
        items: [
          {
            id: "session/1",
            status: "completed",
            createdAt: "2026-08-23T02:00:00.000Z",
            startedAt: "2026-08-23T02:01:00.000Z",
            completedAt: "2026-08-23T02:02:00.000Z",
          },
        ],
      },
    });

    const html = await renderPage(
      ScheduleDetailPage({ params: Promise.resolve({ id: "schedule/one" }) }),
    );
    expect(html).toContain('data-pw="page-schedule-detail"');
    expect(html).toContain('href="/sessions/session%2Factive"');
    expect(html).toContain("Concurrency ID:");
    expect(html).toContain('data-pw="schedule-history-row-session/1"');
    expect(html).toContain('data-pw="form-edit-schedule"');
  });

  it("renders read-only detail fallbacks when dependent APIs fail", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "required");
    stubApi({
      "/api/v1/auth/me": readonlyPrincipal,
      "/api/v1/schedules/schedule-2": {
        id: "schedule-2",
        name: "Readonly",
        repositoryId: "repo-2",
        target: { providerId: "provider-2" },
        fallbacks: [],
        cron: "@daily",
        enabled: false,
        timeout: 60,
        queueTtlSeconds: 60,
        nextRunAt: "tomorrow",
        lastRunAt: null,
      },
      "/api/v1/session-targets": jsonResponse({}, 503),
      "/api/v1/sessions?scheduleId=schedule-2&limit=100": jsonResponse({}, 503),
    });

    const html = await renderPage(
      ScheduleDetailPage({ params: Promise.resolve({ id: "schedule-2" }) }),
    );
    expect(html).toContain("This account cannot edit schedules.");
    expect(html).toContain("No concurrency ID configured.");
    expect(html).toContain("No runs yet.");
    expect(html).not.toContain("schedule-detail-active-session");
  });

  it("renders not found and propagates non-not-found schedule failures", async () => {
    vi.stubEnv("HARNESS_AUTH_MODE", "disabled");
    stubApi({ "/api/v1/schedules/missing": jsonResponse({}, 404) });
    const html = await renderPage(
      ScheduleDetailPage({ params: Promise.resolve({ id: "missing" }) }),
    );
    expect(html).toContain('data-pw="page-schedule-detail-not-found"');

    stubApi({ "/api/v1/schedules/broken": jsonResponse({}, 503) });
    await expect(ScheduleDetailPage({ params: Promise.resolve({ id: "broken" }) })).rejects.toThrow(
      "GET /api/v1/schedules/broken",
    );
  });
});
