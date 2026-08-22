export type {
  AccountType,
  LogStream,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
  UserRole,
  WorktreeStatus,
} from "./types.ts";

export type { AuthzPrincipal, Capability } from "./authz.ts";
export {
  CAPABILITIES,
  ROLE_CAPABILITIES,
  USER_ROLE_DESCRIPTIONS,
  USER_ROLE_LABELS,
  accountGrantError,
  effectiveRole,
  normalizeAccountGrant,
  principalCapabilities,
  principalHas,
  roleHas,
} from "./authz.ts";

export type {
  HostToServerMessage,
  HostWireMessage,
  CreateSessionFields,
  TargetRef,
  SessionAssign,
  SessionResumeSpec,
  SessionLogChunk,
  SessionStatusUpdate,
  SessionActiveStatus,
  SessionTerminalStatus,
} from "./session.ts";

export {
  HOST_CAPABILITIES,
  hasHostCapability,
  isHostCapability,
  normalizeHostCapabilities,
  type HostCapability,
  type HostCapabilities,
} from "./host-capabilities.ts";

export {
  GIT_READINESS_REASONS,
  type GitReadinessReason,
  type HostRuntimeReport,
} from "./host-runtime.ts";

export {
  ACTIVE_SESSION_STATUSES,
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_HOST_KEEPALIVE_MS,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_QUEUE_SHARD_COUNT,
  DEFAULT_QUEUE_TTL_SECONDS,
  DEFAULT_USAGE_LIMIT_COOLDOWN_SECONDS,
  LOCAL_HOST_ID,
  LOCAL_HOST_PANE_HTTP,
  LOCAL_API_HTTP,
  LOCAL_API_WS,
  LOCAL_DDB_HTTP,
  LOCAL_WEB_HTTP,
  PACKAGE_SCOPE,
  SESSION_ERROR_CODES,
  SESSION_SOURCES,
  SESSION_STATUSES,
  SESSION_TYPES,
  TERMINAL_SESSION_STATUSES,
  USER_ROLES,
  WORKTREE_STATUSES,
} from "./constants.ts";
export { validateTargetRouting } from "./validation.ts";
export { isValidUtcTimestamp, nextCronOccurrence, parseCron } from "./cron.ts";

export type { ValidationResult } from "./validation.ts";
export {
  formatLogSortKey,
  concurrencyIdByteLengthError,
  isSessionSource,
  isReservedConcurrencyId,
  isSessionErrorCode,
  isSessionStatus,
  isUserRole,
  isWorktreeStatus,
  isSessionType,
  isActiveSessionStatus,
  isTerminalSessionStatus,
  MAX_PROMPT_BYTES,
  MAX_CONCURRENCY_ID_BYTES,
  promptByteLengthError,
  validateCreateSessionInput,
} from "./validation.ts";

export {
  addHostWorktree,
  defaultWorktreePath,
  emptyHostInventory,
  mergeHostRepository,
  removeHostRepository,
  removeHostWorktree,
  updateHostSetupScript,
  updateHostWorktree,
  upsertHostRepository,
  type HostInventory,
  type HostProviderAccount,
  type HostRepository,
  type HostWorktree,
  type ProviderAccountOverride,
} from "./host-inventory.ts";
export { parseHostInventory } from "./host-inventory-parse.ts";

export {
  isHostRepositoryRegistration,
  validateHostRepositoryRegistrations,
  type HostRepositoryRegistration,
} from "./host-registration.ts";

export {
  buildSessionsApiPath,
  parseSessionListQuery,
  sessionListHref,
  type SessionListQuery,
} from "./list-query.ts";

export { apiBase, apiErrorMessage, apiGet, resolveServerApiBase } from "./api-client.ts";

export { getInventory, mutateInventory, putInventory } from "./host-inventory-api.ts";
export {
  attachProviderAccountToHost,
  detachProviderAccountFromHost,
  setHostProviderAccountCommand,
} from "./host-provider-accounts.ts";
export {
  setScopeProviderCommand,
  setScopeProviderEnabled,
  type ProviderAccountScope,
} from "./scope-provider-accounts.ts";

export { newId } from "./id.ts";
export { isValidSlugName, SLUG_NAME_HINT, SLUG_PATTERN } from "./slug.ts";
export {
  isValidScheduledBranchRef,
  MAX_SCHEDULED_BRANCH_REF_BYTES,
} from "./scheduled-branch-ref.ts";

export {
  parseProviderAccountOverrides,
  parseProviderAccounts,
  type ParsedHostProviderAccount,
  type ParsedProviderAccountOverride,
} from "./provider-account-parse.ts";

export type { Command, Provider, ProviderAccount, ResumeRefCapture } from "./providers.ts";
export { validateUsageRates, type SessionUsage, type UsageRates } from "./usage.ts";
export {
  isValidCliResumeRef,
  MAX_COMMAND_ARGV_ITEMS,
  MAX_COMMAND_ARG_LENGTH,
  MAX_RESUME_REF_CAPTURE_LENGTH,
  materializeResumeArgv,
  validateCommandArgv,
  validateCommandResumeSpec,
  type CommandResumeSpec,
} from "./command-resume.ts";

export {
  resolveProviderAccountCommandId,
  resolveProviderAccountEnabled,
  type ProviderCatalog,
} from "./provider-cascade.ts";
export {
  resolveProviderAccountsForScope,
  type ProviderAccountCommandSource,
  type ProviderAccountScopeResolution,
  type ProviderAccountScopeSource,
} from "./provider-cascade-scope.ts";

export {
  DEFAULT_SLACK_NOTIFICATIONS,
  type PublicSlackIntegration,
  type SlackNotifications,
} from "./slack.ts";

export {
  installCrashLogging,
  onShutdownSignal,
  type LifecycleLogger,
  type ShutdownHandle,
} from "./process-lifecycle.ts";

export { contentSecurityPolicy, securityHeaders, wsOrigin } from "./security-headers.ts";
export { SESSION_COOKIE, hasValidSession, sessionCookieValue } from "./session-cookie.ts";
