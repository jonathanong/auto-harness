import type { SessionRecord } from "./db/types.ts";
import { ControlPlane } from "./control-plane.ts";

/** A minimal terminal-or-running session record for prior-context route tests,
 * with just enough fields to satisfy `SessionRecord` and the route's access checks. */
export function minimalSession(overrides: Partial<SessionRecord> & { id: string }): SessionRecord {
  return {
    repositoryId: "repo",
    prompt: "p",
    target: { commandId: "cmd" },
    fallbacks: [],
    targetDisplayNames: ["echo"],
    queueTtlSeconds: 60,
    queueExpiresAt: "2026-01-01T00:01:00.000Z",
    timeout: 30,
    priority: 0,
    requiredLabels: [],
    status: "completed",
    queueShard: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    type: "prompt",
    source: "api",
    ...overrides,
  };
}

/** A ControlPlane with a deterministic sN session-id sequence and a fixed
 * clock, shared by every resume-retarget / prior-context fixture below. */
export function deterministicPlane(): ControlPlane {
  return new ControlPlane({
    shardCount: 1,
    idFactory: (() => {
      let n = 0;
      return () => `s${++n}`;
    })(),
    now: () => "2026-01-01T00:00:00.000Z",
  });
}

export function registerFixtureHost(
  plane: ControlPlane,
  hostId: string,
  capabilities: string[] = [],
): void {
  plane.registerHost({
    hostId,
    worktrees: [
      { id: `wt-${hostId}`, name: `wt-${hostId}`, repositoryId: "repo", path: "/wt", labels: [] },
    ],
    ...(capabilities.length ? { capabilities: capabilities as never } : {}),
  });
}

function assignedFixtureSession(
  plane: ControlPlane,
  commandId: string,
  prompt: string,
  hostId: string,
  hostCapabilities: string[] = [],
) {
  registerFixtureHost(plane, hostId, hostCapabilities);
  plane.createSession({ repositoryId: "repo", prompt, target: { commandId }, timeout: 30 });
  plane.assignQueued();
  return plane.getSession("s1")!;
}

/** A resume-retarget / assign-wiring fixture: a source session assigned to
 * `cmd-old` on host `host-a` and finished with a captured `cliResumeRef`,
 * plus a `cmd-new` command to rebind onto. Pass `hostCapabilities` to opt
 * `host-a` into advertising capabilities such as `prior-session-context`. */
export function finishedCommandSwapSourcePlane(hostCapabilities: string[] = []): ControlPlane {
  const plane = deterministicPlane();
  plane.createCommand({
    id: "cmd-old",
    name: "old",
    argv: ["old"],
    resumeArgvTemplate: ["old", "resume", "{cliResumeRef}", "{prompt}"],
    resumeRefCapture: { stream: "stdout", linePrefix: "id: " },
  });
  plane.createCommand({ id: "cmd-new", name: "new", argv: ["new"], appendPrompt: true });
  const session = assignedFixtureSession(plane, "cmd-old", "first", "host-a", hostCapabilities);
  plane.handleHostMessage({
    type: "session:status",
    sessionId: "s1",
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
    status: "completed",
    cliResumeRef: "cli-1",
  });
  return plane;
}

/** A prior-context rendering fixture: a single-command session on host
 * `host` that logs `content` to stdout before completing, without ever
 * capturing a native-resume ref. */
export function finishedLoggedSessionPlane(content: string): ControlPlane {
  const plane = deterministicPlane();
  plane.createCommand({ id: "cmd", name: "echo", argv: ["echo"], appendPrompt: true });
  const session = assignedFixtureSession(plane, "cmd", "first run", "host");
  plane.handleHostMessage({
    type: "session:log",
    sessionId: "s1",
    attemptId: session.attemptId!,
    stream: "stdout",
    content,
    timestamp: plane.state.now(),
    seq: 1,
  });
  plane.handleHostMessage({
    type: "session:status",
    sessionId: "s1",
    worktreeId: session.worktreeId!,
    attemptId: session.attemptId!,
    status: "completed",
  });
  return plane;
}
