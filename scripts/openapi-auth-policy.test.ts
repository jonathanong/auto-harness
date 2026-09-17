import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { requiredCapability } from "../services/api/src/auth-policy.ts";
import {
  countRegexBranches,
  extractExactLiterals,
  extractPrefixLiterals,
  isExactlyDocumented,
  isPatternDocumented,
  isPrefixDocumented,
  parseOpenApi,
  resolvedPathname,
} from "./test-helpers/openapi-auth-policy-test-helpers.ts";

const openApiYaml = readFileSync(new URL("../docs/openapi.yaml", import.meta.url), "utf8");
const authPolicySource = readFileSync(
  new URL("../services/api/src/auth-policy.ts", import.meta.url),
  "utf8",
);
const spec = parseOpenApi(openApiYaml);

describe("docs/openapi.yaml parses to a non-trivial paths block", () => {
  // Guards against the scanner silently matching nothing (e.g. an indentation change).
  it("found at least 30 documented path templates", () => {
    expect(spec.templates.length).toBeGreaterThanOrEqual(30);
  });
  it("found at least 40 documented operations", () => {
    expect(spec.operations.length).toBeGreaterThanOrEqual(40);
  });
  it("declares /api/v1 as its base path", () => {
    // requiredCapability expects full pathnames like /api/v1/hosts — get this wrong and
    // every check below passes vacuously against the wrong prefix.
    expect(spec.base).toBe("/api/v1");
  });
});

describe("every documented operation resolves a real capability", () => {
  for (const op of spec.operations) {
    // The two HMAC-signed webhooks declare `security: []` and are dispatched in
    // local-app.ts before the authorize() gate — they never reach requiredCapability.
    if (op.securityNone) continue;
    const pathname = resolvedPathname(spec.base, op.path);
    it(`${op.method} ${pathname} is not an unrouted write`, () => {
      expect(requiredCapability(op.method, pathname)).not.toBeNull();
    });
  }
});

/**
 * Every distinct route pattern requiredCapability branches on in auth-policy.ts, mirrored
 * here because services/api/src/local-app.ts dispatches through ~25 handler modules with no
 * enumerable route table. Two trip-wires keep this list honest instead of silently rotting:
 * the exact/prefix literals are extracted mechanically from auth-policy.ts's own source
 * text (see the "extracted the expected number" test), and the regex-branch sample count
 * below is asserted against the number of `.test(pathname)` call sites in that file.
 */
const REGEX_BRANCH_SAMPLES: Array<{ label: string; example: string }> = [
  {
    label: "/integrations/custom/{id}",
    example: "/api/v1/integrations/custom/example-integration",
  },
  {
    label: "/repositories/{id}/(pause|drain|activate)",
    example: "/api/v1/repositories/repo-1/pause",
  },
  {
    label: "/repositories/{id}/session-drains(/{opId}(/release)?)?",
    example: "/api/v1/repositories/repo-1/session-drains",
  },
  { label: "/hosts/{id}/(exec-config|update-config)", example: "/api/v1/hosts/host-1/exec-config" },
  {
    label: "/workspace-pools/{id}/exec-config",
    example: "/api/v1/workspace-pools/pool-1/exec-config",
  },
  { label: "/hosts/{id}/inventory", example: "/api/v1/hosts/host-1/inventory" },
  {
    label: "/provider-accounts/{id}/leases(/{slot}/release)?",
    example: "/api/v1/provider-accounts/acct-1/leases",
  },
  { label: "/sessions/{id}/log-parts", example: "/api/v1/sessions/sess-1/log-parts" },
  { label: "/sessions/{id}/log-archive", example: "/api/v1/sessions/sess-1/log-archive" },
  { label: "/sessions/{id}/archive", example: "/api/v1/sessions/sess-1/archive" },
  { label: "/sessions/{id}/children", example: "/api/v1/sessions/sess-1/children" },
];

/**
 * Route branches confirmed present in auth-policy.ts but not yet in docs/openapi.yaml.
 * Most of what used to live here (see #768 and the PR that closed this list down to one
 * entry) was ordinary documentation debt with no reason beyond "nobody wrote it yet." What
 * remains is a deliberate exclusion with a named, per-route blocker — not debt. An entry
 * here must actually be undocumented: if the route gets documented later, remove the entry
 * (the assertion below fails otherwise), and if a route is removed from auth-policy.ts, drop
 * the now-unmatched entry (the stale-entry check below fails otherwise).
 *
 * "/api/v1/host/messages" — the host-daemon wire-protocol relay, not a REST resource.
 * Its request body is `HostToServerMessage` (modules/shared/src/session.ts), a discriminated
 * union versioned by HOST_PROTOCOL_VERSION and designed to evolve with the daemon, not as a
 * stable public contract. Six of its message variants (session:ack, session:command-start,
 * session:status, session:log, session:usage, session:terminal-hook-complete) are rejected
 * with 410 HOST_MESSAGE_WEBSOCKET_REQUIRED, because this legacy HTTP relay has no
 * per-connection epoch fence the way the WebSocket does; only host:register, host:status,
 * and host:keepalive are actually reachable here. Documenting an OpenAPI request schema for
 * this path would either (a) describe a union most of whose branches always fail, or (b)
 * describe only the three live branches and silently misrepresent the route. It also runs
 * against this repo's own invariant that hosts talk to the control plane over WebSocket
 * only (CLAUDE.md "the control plane must do everything"), so keeping it out of the
 * REST-facing spec is the accurate outcome, not a gap.
 */
const KNOWN_UNDOCUMENTED = new Set<string>(["/api/v1/host/messages"]);

describe("every auth-policy.ts route branch appears in docs/openapi.yaml (or is allowlisted)", () => {
  const exactLiterals = extractExactLiterals(authPolicySource);
  const prefixLiterals = extractPrefixLiterals(authPolicySource);
  const seen = new Set<string>();

  it("extracted the expected number of literal branches", () => {
    expect(exactLiterals.length + prefixLiterals.length).toBe(19);
  });

  it("mirrors the expected number of regex branches", () => {
    expect(REGEX_BRANCH_SAMPLES.length).toBe(countRegexBranches(authPolicySource));
  });

  for (const literal of exactLiterals) {
    seen.add(literal);
    it(`exact route ${literal}`, () => {
      const documented = isExactlyDocumented(literal, spec.base, spec.templates);
      expect(documented).toBe(!KNOWN_UNDOCUMENTED.has(literal));
    });
  }

  for (const literal of prefixLiterals) {
    seen.add(literal);
    it(`prefix route ${literal}`, () => {
      const documented = isPrefixDocumented(literal, spec.base, spec.templates);
      expect(documented).toBe(!KNOWN_UNDOCUMENTED.has(literal));
    });
  }

  for (const { label, example } of REGEX_BRANCH_SAMPLES) {
    seen.add(label);
    it(`pattern route ${label}`, () => {
      const documented = isPatternDocumented(example, spec.base, spec.templates);
      expect(documented).toBe(!KNOWN_UNDOCUMENTED.has(label));
    });
  }

  it("has no stale KNOWN_UNDOCUMENTED entries", () => {
    for (const id of KNOWN_UNDOCUMENTED) expect(seen.has(id)).toBe(true);
  });
});
