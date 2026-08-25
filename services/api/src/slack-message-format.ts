import type { SlackLifecycleEvent, SlackSessionSnapshot } from "./slack-delivery-types.ts";

const divider = "━━━━━━━━━━━━━━━━━━━━━━━━━";
const maxPromptLength = 500;
const maxErrorLength = 500;

export function formatSlackLifecycleMessage(
  event: SlackLifecycleEvent,
  session: SlackSessionSnapshot,
): string {
  if (event === "session_created") return queuedMessage(session);
  if (event === "session_started") {
    return [
      "▶️ Session started",
      `Agent: ${session.hostId ?? "—"}`,
      `Worktree: ${session.worktreeId ?? "main checkout"}`,
      `Session: ${session.url}`,
    ].join("\n");
  }
  if (event === "session_cancelled") {
    return [`⚪ Session cancelled${actorSuffix(session)}`, `Session: ${session.url}`].join("\n");
  }
  if (event === "session_completed") {
    return [
      `✅ Session completed${durationSuffix(session)}`,
      `Exit code: ${session.exitCode ?? 0}`,
      `Session: ${session.url}`,
    ].join("\n");
  }
  if (event === "host_offline") {
    return [`⚠️ Host offline`, `Host: ${session.hostId ?? session.id}`].join("\n");
  }
  return failedMessage(session);
}

export function formatSlackFinalRoot(session: SlackSessionSnapshot): string {
  const status = session.status === "completed" ? "✅ Session completed" : terminalLabel(session);
  return [
    `${status} — ${session.repositoryName}${durationSuffix(session)}`,
    divider,
    `Prompt: ${bounded(session.prompt, maxPromptLength)}`,
    `Command: ${session.commandLabel}`,
    ...(session.exitCode === undefined ? [] : [`Exit code: ${session.exitCode ?? "—"}`]),
    `Session: ${session.url}`,
  ].join("\n");
}

function queuedMessage(session: SlackSessionSnapshot): string {
  return [
    `📋 Session queued — ${session.repositoryName}`,
    divider,
    `Prompt: ${bounded(session.prompt, maxPromptLength)}`,
    `Command: ${session.commandLabel}`,
    `Priority: ${session.priority}`,
    `Source: ${session.source}${actorSuffix(session)}`,
    `Session: ${session.url}`,
  ].join("\n");
}

function failedMessage(session: SlackSessionSnapshot): string {
  if (session.errorCode === "usage_limit") {
    return [
      "❌ Session failed — usage limit",
      "The AI CLI reported a plan or rate limit. Auto Harness will apply configured account cooldown and fallback routing.",
      `Session: ${session.url}`,
    ].join("\n");
  }
  const tail = (session.stderrTail ?? []).slice(-5).map((line) => `> ${bounded(line, 300)}`);
  return [
    `${terminalLabel(session)}${durationSuffix(session)}`,
    ...(session.exitCode === undefined ? [] : [`Exit code: ${session.exitCode ?? "—"}`]),
    ...(session.errorMessage ? [`Error: ${bounded(session.errorMessage, maxErrorLength)}`] : []),
    ...(tail.length ? ["", "Last 5 lines of stderr:", ...tail] : []),
    `Session: ${session.url}`,
  ].join("\n");
}

function terminalLabel(session: SlackSessionSnapshot): string {
  if (session.status === "cancelled") return "⚪ Session cancelled";
  if (session.status === "timed_out") return "❌ Session timed out";
  return "❌ Session failed";
}

function actorSuffix(session: SlackSessionSnapshot): string {
  return session.sourceActor ? ` (${session.sourceActor})` : "";
}

function durationSuffix(session: SlackSessionSnapshot): string {
  const start = Date.parse(session.startedAt ?? session.createdAt);
  const end = Date.parse(session.completedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "";
  const seconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return ` in ${minutes}m ${remainder}s`;
}

function bounded(value: string, limit: number): string {
  const normalized = value.replace(/[\r\n\t]+/g, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}…`;
}
