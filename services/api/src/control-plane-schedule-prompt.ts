export type ScheduleInput = {
  repositoryId: string;
  name: string;
  target: unknown;
  fallbacks?: unknown;
  cron: string;
  timeout: number;
  queueTtlSeconds?: number;
  /** Legacy client input. The server validates it but always derives the cursor. */
  nextRunAt?: string;
  enabled?: boolean;
  ref?: string;
  concurrencyId?: string;
  prompt?: string;
  id?: string;
  /** Internal authenticated owner; public JSON cannot select another principal. */
  principalId?: string;
};

/** Session prompt used when a schedule fires. Never invents `scheduled:<name>`. */
export function scheduledSessionPrompt(schedule: { prompt?: string }): string {
  return schedule.prompt?.trim() ?? "";
}

/** Persist a trimmed prompt, or omit a blank one. */
export function storedSchedulePrompt(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function applyStoredPrompt(record: { prompt?: string }, value: string): void {
  const prompt = storedSchedulePrompt(value);
  if (prompt !== undefined) record.prompt = prompt;
  else delete record.prompt;
}
