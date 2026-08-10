export type {
  AccountType,
  LogStream,
  OnConflict,
  SessionErrorCode,
  SessionSource,
  SessionStatus,
  SessionType,
  UserRole,
  WorktreeStatus,
} from "./types.ts";

export type {
  HostToServerMessage,
  HostWireMessage,
  CreateSessionFields,
  SessionAssign,
  SessionResumeSpec,
  SessionLogChunk,
  SessionStatusUpdate,
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
  DEFAULT_ACK_DEADLINE_MS,
  DEFAULT_HOST_KEEPALIVE_MS,
  DEFAULT_ARCHIVE_PREFIX,
  DEFAULT_HEARTBEAT_STALE_MS,
  DEFAULT_QUEUE_SHARD_COUNT,
  DEFAULT_USAGE_LIMIT_RETRY_CEILING,
  LOCAL_HOST_ID,
  LOCAL_HOST_PANE_HTTP,
  LOCAL_API_HTTP,
  LOCAL_API_WS,
  LOCAL_DDB_HTTP,
  LOCAL_WEB_HTTP,
  ON_CONFLICT_OPTIONS,
  PACKAGE_SCOPE,
  SESSION_ERROR_CODES,
  SESSION_SOURCES,
  SESSION_STATUSES,
  SESSION_TYPES,
  TERMINAL_SESSION_STATUSES,
} from "./constants.ts";

export type { ValidationResult } from "./validation.ts";
export {
  formatLogSortKey,
  isOnConflict,
  isSessionSource,
  isSessionErrorCode,
  isSessionStatus,
  isSessionType,
  isTerminalSessionStatus,
  validateCreateSessionInput,
} from "./validation.ts";

export {
  DEFAULT_ECHO_PROFILE,
  addHostWorktree,
  defaultWorktreePath,
  emptyHostInventory,
  mergeHostRepository,
  removeHostRepository,
  removeHostWorktree,
  updateHostWorktree,
  upsertHostRepository,
  type HostInventory,
  type HostProviderAccount,
  type HostRepository,
  type HostWorktree,
  type ProviderAccountOverride,
} from "./host-inventory.ts";

export {
  buildSessionsApiPath,
  parseSessionListQuery,
  sessionListHref,
  type SessionListQuery,
} from "./list-query.ts";

export { apiBase, apiGet, resolveServerApiBase } from "./api-client.ts";

export { getInventory, putInventory } from "./host-inventory-api.ts";
export { removeCommandProfile, setCommandProfile } from "./command-profiles.ts";
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
