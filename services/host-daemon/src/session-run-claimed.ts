/* eslint-disable max-lines -- claimed run covers setup, profile env, and terminal outcomes. */
import { thrownMessage } from "@auto-harness/shared";
import type { SessionAssign, SessionLogChunk } from "@auto-harness/shared";

import type { ProcessResult, ProcessRunner } from "./executor.ts";
import { httpBaseFromApiUrl } from "./bootstrap.ts";
import {
  applyExecutionProfile,
  emptyExecutionProfiles,
  executionProfileReady,
  resolveExecutionProfile,
  type ExecutionProfiles,
} from "./execution-profiles.ts";
import type { LogStreamer } from "./log-streamer.ts";
import { runSetupIfNeeded, type ClaimedWorktree } from "./session-run-setup.ts";
import { finishClaimedSession, type SessionRunResult } from "./session-outcome.ts";
import { ResumeRefCaptureReader } from "./resume-ref-capture.ts";
import { detectUsageLimit } from "./usage-limit.ts";
import {
  removePriorContextFile,
  writePriorContextFile,
  type PriorContextIdentity,
} from "./prior-context-file.ts";
import {
  GITHUB_APP_TOKEN_MARGIN_MS,
  githubBotEmail,
  mintInstallationToken,
  withoutAmbientGitHubTokens,
  type GitHubAppConfig,
  type InstallationToken,
} from "./github-app.ts";
import { SecretRedactingProcessRunner } from "./secret-redacting-runner.ts";

const SESSION_CREDENTIAL_REDACTION = "[session credential redacted]";
// A single character (or other tiny suffix) can naturally occur in ordinary
// output. Once the credential's stable prefix is present, retaining it avoids
// releasing a plausibly useful credential fragment across chunk boundaries.
const MIN_REDACTED_CREDENTIAL_PREFIX_LENGTH = "hns_session_".length;

class SessionCredentialRedactor {
  private pending = "";
  private pendingStream = "stdout";
  private readonly credential: string | undefined;

  constructor(credential?: string) {
    this.credential = credential;
  }

  push(stream: string, content: string): string {
    if (!this.credential) return content;
    let prefixRedaction = "";
    let combined = this.pending + content;
    if (this.pending && !combined.startsWith(this.credential)) {
      if (this.credential.startsWith(combined)) {
        this.pending = combined;
        this.pendingStream = stream;
        return "";
      }
      // Preserve harmless short overlaps from ordinary output, but never
      // release a prefix long enough to identify the credential namespace.
      prefixRedaction =
        this.pending.length < MIN_REDACTED_CREDENTIAL_PREFIX_LENGTH
          ? this.pending
          : SESSION_CREDENTIAL_REDACTION;
      combined = content;
    }
    let heldLength = 0;
    // A complete credential can itself have a suffix matching its first
    // character(s). Do not retain such an overlap: otherwise the safe prefix
    // and drained suffix would reconstruct the secret in the transcript.
    const lastCompleteCredential = combined.lastIndexOf(this.credential);
    const trailingAfterCredential =
      lastCompleteCredential === -1
        ? combined.length
        : combined.length - (lastCompleteCredential + this.credential.length);
    const maximum = Math.min(trailingAfterCredential, this.credential.length - 1);
    for (let length = maximum; length > 0; length -= 1) {
      if (combined.endsWith(this.credential.slice(0, length))) {
        heldLength = length;
        break;
      }
    }
    const safe = heldLength === 0 ? combined : combined.slice(0, -heldLength);
    this.pending = heldLength === 0 ? "" : combined.slice(-heldLength);
    if (this.pending) this.pendingStream = stream;
    return prefixRedaction + this.redact(safe);
  }

  drain(): Array<{ stream: string; content: string }> {
    const trailing = this.pending
      ? [
          {
            stream: this.pendingStream,
            content:
              this.pending.length < MIN_REDACTED_CREDENTIAL_PREFIX_LENGTH
                ? this.pending
                : SESSION_CREDENTIAL_REDACTION,
          },
        ]
      : [];
    this.pending = "";
    return trailing;
  }

  redact(content: string): string {
    return this.credential
      ? content.split(this.credential).join(SESSION_CREDENTIAL_REDACTION)
      : content;
  }
}

/**
 * Run setup + command for an already-claimed worktree (checkout already done).
 * argv is resolved control-plane-side (cascade walk + prompt append); the daemon
 * just spawns it. A missing/empty resolvedArgv should be unreachable — the scheduler
 * only assigns worktrees that already resolved a command — but is checked defensively
 * rather than trusted blindly off the wire.
 */
export async function runClaimedSession(
  processRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
  remainingMs: () => number,
  commandRunner: ProcessRunner = processRunner,
  childEnvSource: NodeJS.ProcessEnv = process.env,
  executionProfiles: ExecutionProfiles = emptyExecutionProfiles(),
  /** Daemon identity used only to fetch `assign.priorContext`; never forwarded to the CLI. */
  identity?: PriorContextIdentity,
  githubApp?: GitHubAppConfig,
  nowMs: () => number = Date.now,
  /** HEAD captured after checkout and before setup; used for post-session facts. */
  baseline?: string,
): Promise<SessionRunResult> {
  const mappedGitHubApp = githubApp?.repositories.has(assign.repositoryId) ?? false;
  const sessionChildEnv = mappedGitHubApp
    ? withoutAmbientGitHubTokens(childEnvSource)
    : childEnvSource;
  try {
    await claimed.currentExecutionTarget?.();
  } catch (error) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorCode: "setup_failed",
        errorMessage: thrownMessage(error),
      },
      sessionChildEnv,
      baseline,
    );
  }
  const setup = await runSetupIfNeeded(
    processRunner,
    streamer,
    logs,
    assign,
    claimed,
    signal,
    timedOut,
    remainingMs,
    sessionChildEnv,
    baseline,
  );
  if (setup.failure) return setup.failure;

  try {
    await claimed.currentExecutionTarget?.();
  } catch (error) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorCode: "setup_failed",
        errorMessage: thrownMessage(error),
      },
      setup.environment,
      baseline,
      true,
    );
  }

  if (signal?.aborted) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      { status: timedOut() ? "timed_out" : "cancelled", exitCode: null },
      setup.environment,
      baseline,
      true,
    );
  }

  if (assign.resolvedArgv.length === 0) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorCode: "unknown_command_profile",
        errorMessage: "no resolved command argv for this session",
      },
      setup.environment,
      baseline,
      true,
    );
  }

  return await runProcessAndFinish(
    processRunner,
    commandRunner,
    streamer,
    logs,
    assign,
    claimed,
    assign.resolvedArgv,
    signal,
    timedOut,
    remainingMs,
    setup.environment,
    executionProfiles,
    identity,
    githubApp,
    nowMs,
    baseline,
  );
}

async function runProcessAndFinish(
  processRunner: ProcessRunner,
  commandRunner: ProcessRunner,
  streamer: LogStreamer,
  logs: SessionLogChunk[],
  assign: SessionAssign,
  claimed: ClaimedWorktree,
  argv: string[],
  signal: AbortSignal | undefined,
  timedOut: () => boolean,
  remainingMs: () => number,
  environment: NodeJS.ProcessEnv,
  executionProfiles: ExecutionProfiles = emptyExecutionProfiles(),
  identity?: PriorContextIdentity,
  githubApp?: GitHubAppConfig,
  nowMs: () => number = Date.now,
  baseline?: string,
): Promise<SessionRunResult> {
  const terminalEnvironment = githubApp?.repositories.has(assign.repositoryId)
    ? withoutAmbientGitHubTokens(environment)
    : environment;
  streamer.write(
    "system",
    `Spawning: ${argv[0]} (argument count: ${Math.max(0, argv.length - 1)})`,
  );
  const capturePolicy =
    commandRunner.outputStreams === "merged" && assign.resumeRefCapture
      ? { ...assign.resumeRefCapture, stream: "either" as const }
      : assign.resumeRefCapture;
  const resumeRef = new ResumeRefCaptureReader(capturePolicy);
  const credentialRedactor = new SessionCredentialRedactor(assign.sessionApiKey);
  const profile = resolveExecutionProfile(executionProfiles, assign.providerAccountId);
  if (assign.providerAccountId && (!profile || !executionProfileReady(profile))) {
    return await finishClaimedSession(
      processRunner,
      streamer,
      logs,
      assign,
      claimed,
      {
        status: "failed",
        exitCode: null,
        errorMessage: `execution profile unavailable for ${assign.providerAccountId}`,
      },
      terminalEnvironment,
      baseline,
      true,
    );
  }
  const commandEnv = profile
    ? applyExecutionProfile(terminalEnvironment, profile)
    : { ...terminalEnvironment };
  delete commandEnv.HARNESS_API_KEY;
  delete commandEnv.HARNESS_SESSION_API_KEY;
  delete commandEnv.HARNESS_SESSION_ID;
  // Written after setup (which may `git clean`/reset the checkout — resumeWireFields omits
  // `resume: true` for a fallback, so setup still runs) and removed once the process exits.
  const priorContextPath =
    assign.priorContext && identity
      ? await writePriorContextFile({
          cwd: claimed.cwd,
          sessionId: assign.sessionId,
          identity,
          ...(claimed.allowedRoots ? { allowedRoots: claimed.allowedRoots } : {}),
          onLog: (message) => streamer.write("system", message),
          ...(signal ? { signal } : {}),
          timeoutMs: Math.max(0, remainingMs()),
        })
      : null;
  if (priorContextPath) streamer.write("system", "Wrote prior-session context for this run");
  let installationToken: InstallationToken | undefined;
  if (githubApp?.repositories.has(assign.repositoryId)) {
    try {
      installationToken = await mintInstallationToken(
        githubApp,
        assign.repositoryId,
        signal,
        fetch,
        nowMs,
      );
      if (
        !installationToken ||
        installationToken.expiresAtMs - nowMs() <= GITHUB_APP_TOKEN_MARGIN_MS
      ) {
        throw new Error("GitHub App token expires too soon to run a session");
      }
    } catch {
      await removePriorContextFile(priorContextPath);
      if (signal?.aborted) {
        return await finishClaimedSession(
          processRunner,
          streamer,
          logs,
          assign,
          claimed,
          { status: timedOut() ? "timed_out" : "cancelled", exitCode: null },
          terminalEnvironment,
          baseline,
          true,
        );
      }
      return await finishClaimedSession(
        processRunner,
        streamer,
        logs,
        assign,
        claimed,
        {
          status: "failed",
          exitCode: null,
          errorCode: "setup_failed",
          errorMessage: "GitHub App credential provisioning failed",
        },
        terminalEnvironment,
        baseline,
        true,
      );
    }
  }
  const scopedCommandEnv = installationToken ? withoutAmbientGitHubTokens(commandEnv) : commandEnv;
  // The daemon's host credential must never reach an agent command. Give the
  // primary command only its one-attempt child-session credential instead;
  // setup, checkout, and terminal hooks retain their existing environment.
  const sessionEnv =
    identity && assign.sessionApiKey
      ? {
          ...scopedCommandEnv,
          HARNESS_API_URL: httpBaseFromApiUrl(identity.apiUrl),
          HARNESS_SESSION_ID: assign.sessionId,
          HARNESS_SESSION_API_KEY: assign.sessionApiKey,
        }
      : scopedCommandEnv;
  const authenticatedEnv = installationToken
    ? {
        ...sessionEnv,
        GH_TOKEN: installationToken.token,
        GIT_AUTHOR_NAME: githubApp!.botLogin,
        GIT_AUTHOR_EMAIL: githubBotEmail(githubApp!),
        GIT_COMMITTER_NAME: githubApp!.botLogin,
        GIT_COMMITTER_EMAIL: githubBotEmail(githubApp!),
      }
    : sessionEnv;
  // Terminal hooks implement repository-scoped completion/escalation policy (including GitHub
  // issue creation), so they receive the same short-lived App identity as the assigned command.
  // Early finish paths before successful minting continue to receive only the scrubbed environment.
  const authenticatedTerminalEnvironment = installationToken
    ? {
        ...terminalEnvironment,
        GH_TOKEN: installationToken.token,
        GIT_AUTHOR_NAME: githubApp!.botLogin,
        GIT_AUTHOR_EMAIL: githubBotEmail(githubApp!),
        GIT_COMMITTER_NAME: githubApp!.botLogin,
        GIT_COMMITTER_EMAIL: githubBotEmail(githubApp!),
        HARNESS_CHILD_ENV_ALLOWLIST: [
          terminalEnvironment.HARNESS_CHILD_ENV_ALLOWLIST,
          "GH_TOKEN",
          "GIT_AUTHOR_NAME",
          "GIT_AUTHOR_EMAIL",
          "GIT_COMMITTER_NAME",
          "GIT_COMMITTER_EMAIL",
        ]
          .filter(Boolean)
          .join(","),
      }
    : terminalEnvironment;
  const spawnEnv = priorContextPath
    ? { ...authenticatedEnv, HARNESS_PRIOR_CONTEXT_FILE: priorContextPath }
    : authenticatedEnv;
  const timeoutMs = installationToken
    ? Math.min(
        remainingMs(),
        Math.max(1, installationToken.expiresAtMs - nowMs() - GITHUB_APP_TOKEN_MARGIN_MS),
      )
    : remainingMs();
  const effectiveCommandRunner = installationToken
    ? new SecretRedactingProcessRunner(commandRunner, installationToken.token)
    : commandRunner;
  const effectiveTerminalRunner = installationToken
    ? new SecretRedactingProcessRunner(processRunner, installationToken.token)
    : processRunner;
  const finish = (outcome: Parameters<typeof finishClaimedSession>[5]) =>
    finishClaimedSession(
      effectiveTerminalRunner,
      streamer,
      logs,
      assign,
      claimed,
      outcome,
      authenticatedTerminalEnvironment,
      baseline,
      true,
    );
  let result: ProcessResult | undefined;
  let runnerRejected = false;
  let runnerError: unknown;
  try {
    result = await effectiveCommandRunner.run({
      argv,
      cwd: claimed.cwd,
      env: spawnEnv,
      timeoutMs,
      ...(signal ? { signal } : {}),
      onChunk: (c) => {
        const redacted = credentialRedactor.push(c.stream, c.data);
        const safeContent = resumeRef.push(c.stream, redacted);
        if (safeContent) streamer.write(c.stream, safeContent);
      },
    });
  } catch (error) {
    runnerRejected = true;
    runnerError = error;
  } finally {
    // Must run even if the process rejects — otherwise the transcript of a
    // *different* session lingers in this (likely reused) worktree.
    await removePriorContextFile(priorContextPath);
  }
  for (const trailing of credentialRedactor.drain()) {
    const safeContent = resumeRef.push(trailing.stream as "stdout" | "stderr", trailing.content);
    if (safeContent) streamer.write(trailing.stream as "stdout" | "stderr", safeContent);
  }
  if (runnerRejected) {
    const cliResumeRef = resumeRef.finish();
    for (const trailing of resumeRef.drainTrailing()) {
      streamer.write(trailing.stream, trailing.content);
    }
    streamer.write("system", "Process execution failed.");
    return await finish({
      status: "failed",
      exitCode: null,
      errorCode: "setup_failed",
      errorMessage: thrownMessage(runnerError),
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
    });
  }
  const completedResult = result!;
  const cliResumeRef = resumeRef.finish();
  for (const trailing of resumeRef.drainTrailing()) {
    streamer.write(trailing.stream, trailing.content);
  }
  if (cliResumeRef) streamer.write("system", "Captured CLI resume reference");
  streamer.write(
    "system",
    completedResult.exitCode === null
      ? "Process exited without an exit code"
      : `Process exited with code ${String(completedResult.exitCode)}`,
  );

  if (completedResult.timedOut || timedOut()) {
    return await finish({
      status: "timed_out",
      exitCode: completedResult.exitCode,
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(completedResult.usage !== undefined ? { usage: completedResult.usage } : {}),
      ...(completedResult.agentSummary !== undefined
        ? { agentSummary: credentialRedactor.redact(completedResult.agentSummary) }
        : {}),
    });
  }

  if (completedResult.cancelled || signal?.aborted) {
    return await finish({
      status: "cancelled",
      exitCode: completedResult.exitCode,
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(completedResult.usage !== undefined ? { usage: completedResult.usage } : {}),
      ...(completedResult.agentSummary !== undefined
        ? { agentSummary: credentialRedactor.redact(completedResult.agentSummary) }
        : {}),
    });
  }

  if (completedResult.exitCode === 0) {
    return await finish({
      status: "completed",
      exitCode: 0,
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(completedResult.usage !== undefined ? { usage: completedResult.usage } : {}),
      ...(completedResult.agentSummary !== undefined
        ? { agentSummary: credentialRedactor.redact(completedResult.agentSummary) }
        : {}),
    });
  }

  const usageLimit = detectUsageLimit({
    argv,
    failed: true,
    ...(assign.providerAccountId ? { providerAccountId: assign.providerAccountId } : {}),
    ...(completedResult.usageLimit === true ? { adapterUsageLimit: true } : {}),
  });
  if (usageLimit) {
    return await finish({
      status: "failed",
      exitCode: completedResult.exitCode,
      errorCode: "usage_limit",
      errorMessage: "Usage limit detected",
      ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
      ...(completedResult.usage !== undefined ? { usage: completedResult.usage } : {}),
      ...(completedResult.agentSummary !== undefined
        ? { agentSummary: credentialRedactor.redact(completedResult.agentSummary) }
        : {}),
    });
  }

  return await finish({
    status: "failed",
    exitCode: completedResult.exitCode,
    errorMessage: `process exited with code ${String(completedResult.exitCode)}`,
    ...(cliResumeRef !== undefined ? { cliResumeRef } : {}),
    ...(completedResult.usage !== undefined ? { usage: completedResult.usage } : {}),
    ...(completedResult.agentSummary !== undefined
      ? { agentSummary: credentialRedactor.redact(completedResult.agentSummary) }
      : {}),
  });
}
