import { describe, expect, it } from "vitest";

import { managementCommands } from "../modules/client/src/cli/management-commands.js";
import {
  expandRoutePattern,
  extractExactMethodPaths,
  extractRouteTemplates,
  readRouteSources,
} from "./cli-route-surface.ts";

const EXCLUDED = [
  { method: "POST", path: "/api/v1/host/messages", audience: "host-protocol" },
  { method: "PUT", path: "/api/v1/sessions/{}/log-parts", audience: "host-protocol" },
  { method: "PUT", path: "/api/v1/sessions/{}/log-archive", audience: "host-protocol" },
  { method: "POST", path: "/api/v1/scheduler/assign", audience: "scheduler" },
  { method: "POST", path: "/api/v1/scheduler/ack-deadlines", audience: "scheduler" },
  { method: "POST", path: "/api/v1/scheduler/reclaim-stale", audience: "scheduler" },
  { method: "POST", path: "/api/v1/scheduler/cron", audience: "scheduler" },
  { method: "POST", path: "/api/v1/webhooks/github", audience: "ingress" },
  { method: "POST", path: "/api/v1/webhooks/custom/{}", audience: "ingress" },
  { method: "POST", path: "/api/v1/integrations/slack/events", audience: "ingress" },
  { method: "GET", path: "/api/v1/integrations/slack/oauth/callback", audience: "ingress" },
  { method: "POST", path: "/api/v1/auth/logout", audience: "browser-session" },
  { method: "POST", path: "/api/v1/auth/viewer-ticket", audience: "browser-session" },
] as const;

function canonical(path: string): string {
  const prefixed = path === "/health" || path.startsWith("/api/v1/") ? path : `/api/v1${path}`;
  return prefixed.replace(/:[A-Za-z0-9]+/g, "{}");
}

function operationKey(method: string, path: string): string {
  return `${method} ${canonical(path)}`;
}

describe("route pattern expansion", () => {
  it("expands admission, optional release, and lease slots", () => {
    expect(expandRoutePattern("^/api/v1/repositories/([^/]+)/(pause|drain|activate)$")).toEqual([
      "/api/v1/repositories/{}/pause",
      "/api/v1/repositories/{}/drain",
      "/api/v1/repositories/{}/activate",
    ]);
    expect(
      expandRoutePattern("^/api/v1/repositories/([^/]+)/session-drains/([^/]+)(/release)?$"),
    ).toEqual([
      "/api/v1/repositories/{}/session-drains/{}",
      "/api/v1/repositories/{}/session-drains/{}/release",
    ]);
    expect(
      expandRoutePattern("^/api/v1/provider-accounts/([^/]+)/leases(?:/([^/]+)/release)?$"),
    ).toEqual([
      "/api/v1/provider-accounts/{}/leases",
      "/api/v1/provider-accounts/{}/leases/{}/release",
    ]);
  });
});

describe("management CLI coverage", () => {
  const source = readRouteSources();
  const extractedPaths = extractRouteTemplates(source);
  const manifestOps = managementCommands.flatMap((command) =>
    command.methods.map((method) => ({
      method,
      path: canonical(command.path),
      id: command.id,
    })),
  );
  const catalogPaths = new Set<string>([
    ...manifestOps.map((operation) => operation.path),
    ...EXCLUDED.map((operation) => operation.path),
  ]);
  const catalogOperations = new Set<string>([
    ...manifestOps.map((operation) => operationKey(operation.method, operation.path)),
    ...EXCLUDED.map((operation) => operationKey(operation.method, operation.path)),
  ]);

  it("classifies every extracted route template and has no stale template", () => {
    const missing = [...extractedPaths].filter((path) => !catalogPaths.has(path)).toSorted();
    const stale = [...catalogPaths].filter((path) => !extractedPaths.has(path)).toSorted();
    expect({ missing, stale }).toEqual({ missing: [], stale: [] });
  });

  it("gives every management operation exactly one command and keeps excluded routes off the CLI", () => {
    const seen = new Map<string, string>();
    for (const operation of manifestOps) {
      const key = operationKey(operation.method, operation.path);
      const owner = seen.get(key);
      expect(owner, key).toBeUndefined();
      seen.set(key, operation.id);
    }
    for (const operation of EXCLUDED) {
      expect(seen.has(operationKey(operation.method, operation.path))).toBe(false);
    }
    expect(new Set(managementCommands.map((command) => command.id)).size).toBe(
      managementCommands.length,
    );
  });

  it("covers every exact method and path pair written next to a pathname check", () => {
    const pairs = [...extractExactMethodPaths(source)];
    const missing = pairs.filter((pair) => !catalogOperations.has(pair)).toSorted();
    expect(missing).toEqual([]);
  });
});
