import {
  formatLogSortKey,
  type HostToServerMessage,
  type SessionStatus,
} from "@auto-harness/shared";

import type { LogRecord } from "./control-plane-types.ts";
import type { ControlPlaneState } from "./control-plane-state.ts";
import { persistSession, queueWrite } from "./control-plane-state.ts";
import { heartbeat, registerAgent } from "./control-plane-agents.ts";
import { archiveSessionLogs, maybeDeliverWebhook } from "./control-plane-lifecycle.ts";
import { releaseWorktree } from "./control-plane-worktrees.ts";

export function appendLog(
  state: ControlPlaneState,
  opts: {
    sessionId: string;
    stream: string;
    content: string;
    timestamp: string;
    seq: number;
  },
): LogRecord {
  const timestampSeq = formatLogSortKey(opts.timestamp, opts.seq);
  const rec: LogRecord = {
    sessionId: opts.sessionId,
    timestampSeq,
    stream: opts.stream,
    content: opts.content,
    timestamp: opts.timestamp,
    seq: opts.seq,
  };
  const list = state.logs.get(opts.sessionId) ?? [];
  list.push(rec);
  list.sort((a, b) => a.timestampSeq.localeCompare(b.timestampSeq));
  state.logs.set(opts.sessionId, list);
  if (state.storage) {
    queueWrite(state, state.storage.putLog(rec));
  }
  return rec;
}

export function getLogs(state: ControlPlaneState, sessionId: string): LogRecord[] {
  return [...(state.logs.get(sessionId) ?? [])];
}

export function handleAgentMessage(
  state: ControlPlaneState,
  msg: HostToServerMessage,
): { ok: boolean; error?: string } {
  switch (msg.type) {
    case "host:register": {
      const r = registerAgent(state, {
        agentId: msg.agentId,
        worktrees: msg.worktrees,
        commandProfiles: msg.commandProfiles,
      });
      return r.ok ? { ok: true } : { ok: false, error: r.error };
    }
    case "session:ack": {
      const session = state.sessions.get(msg.sessionId);
      if (!session) {
        return { ok: false, error: "session not found" };
      }
      if (session.status !== "running") {
        return { ok: true };
      }
      session.ackReceivedAt = state.now();
      state.pendingAcks.delete(msg.sessionId);
      return { ok: true };
    }
    case "session:status": {
      return applySessionStatus(state, msg);
    }
    case "session:log": {
      appendLog(state, {
        sessionId: msg.sessionId,
        stream: msg.stream,
        content: msg.content,
        timestamp: msg.timestamp,
        seq: msg.seq,
      });
      return { ok: true };
    }
    case "host:keepalive": {
      return heartbeat(state, msg.agentId, msg.at)
        ? { ok: true }
        : { ok: false, error: "agent not connected" };
    }
  }
}

function applySessionStatus(
  state: ControlPlaneState,
  msg: {
    sessionId: string;
    status: SessionStatus;
    exitCode?: number | null;
    errorCode?: string;
    errorMessage?: string;
    cliResumeRef?: string;
  },
): { ok: boolean; error?: string } {
  const session = state.sessions.get(msg.sessionId);
  if (!session) {
    return { ok: false, error: "session not found" };
  }

  const terminal =
    msg.status === "completed" ||
    msg.status === "failed" ||
    msg.status === "cancelled" ||
    msg.status === "timed_out";

  if (session.status !== "running") {
    if (terminal && session.worktreeId) {
      const wt = state.worktrees.get(session.worktreeId);
      if (wt?.currentSessionId === session.id) {
        releaseWorktree(state, session.worktreeId);
      }
      session.worktreeId = null;
      session.agentId = null;
    }
    return { ok: true };
  }

  session.status = msg.status;
  if (msg.exitCode !== undefined) {
    session.exitCode = msg.exitCode;
  }
  if (msg.errorCode !== undefined) {
    session.errorCode = msg.errorCode;
  }
  if (msg.errorMessage !== undefined) {
    session.errorMessage = msg.errorMessage;
  }
  if (msg.cliResumeRef !== undefined) {
    session.cliResumeRef = msg.cliResumeRef;
  }

  if (terminal) {
    session.completedAt = state.now();
    state.pendingAcks.delete(msg.sessionId);
    if (session.worktreeId) {
      releaseWorktree(state, session.worktreeId);
    }

    let retries = 0;
    if (session.retryCount !== undefined) {
      retries = session.retryCount;
    }
    if (
      msg.status === "failed" &&
      msg.errorCode === "usage_limit" &&
      retries < state.usageLimitRetryCeiling
    ) {
      const retryCount = retries + 1;
      session.retryCount = retryCount;
      const backoffMs = 1000 * 2 ** (retryCount - 1);
      session.retryAfter = new Date(Date.parse(state.now()) + backoffMs).toISOString();
      session.status = "queued";
      session.worktreeId = null;
      session.agentId = null;
      delete session.completedAt;
    } else {
      session.worktreeId = null;
      void archiveSessionLogs(state, session.id);
      void maybeDeliverWebhook(state, session);
    }
  }
  persistSession(state, session);
  return { ok: true };
}
