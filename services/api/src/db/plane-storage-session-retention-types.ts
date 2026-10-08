export type RetentionJob = {
  scopeKey: string;
  recordKey: string;
  sessionId: string;
  repositoryId: string;
  principalId?: string;
  queueShard: number;
  activityGeneration: string;
  createdAt: string;
  completedAt: string;
  token: string;
  readyAt: string;
  retentionDays: number;
};
