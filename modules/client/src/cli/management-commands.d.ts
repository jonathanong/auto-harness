export type ManagementHeader = {
  flag: string;
  header: string;
  required?: boolean;
};

export type ManagementQuery = {
  flag: string;
  name: string;
  required?: boolean;
};

export type ManagementBody = "none" | "optional" | "required" | "file";

export type ManagementCommand = {
  id: string;
  argv?: readonly string[];
  methods: readonly string[];
  defaultMethod: string;
  path: string;
  params: readonly string[];
  query: readonly ManagementQuery[];
  paging: boolean;
  body: ManagementBody;
  headers: readonly ManagementHeader[];
  via?: string;
};

export const managementCommands: readonly ManagementCommand[];

export function formatUsageLine(command: ManagementCommand): string;

export function manifestUsageLines(): string[];

export function usageUnder(prefix: readonly string[]): string[];
