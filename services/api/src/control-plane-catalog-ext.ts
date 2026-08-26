/* eslint-disable max-lines -- catalog CRUD and provider-account lease operations share one facade. */
import type { CommandRecord, ProviderAccountRecord, ProviderRecord } from "./db/plane-storage.ts";
import type { ResumeRefCapture, UsageRates } from "@auto-harness/shared";
import type { ControlPlaneState } from "./control-plane-state.ts";
import * as commands from "./control-plane-commands.ts";
import * as durableCommands from "./control-plane-commands-durable.ts";
import type { CommandInput } from "./control-plane-commands.ts";
import * as providerAccounts from "./control-plane-provider-accounts.ts";
import * as durableProviderAccounts from "./control-plane-provider-accounts-durable.ts";
import * as providers from "./control-plane-providers.ts";
import { listSessionTargets, type SessionTarget } from "./control-plane-session-targets.ts";
import * as durableCatalog from "./control-plane-durable-read-catalog.ts";
import * as durableRuntime from "./control-plane-durable-read-runtime.ts";
import {
  forceReleaseProviderAccountLease,
  listProviderAccountLeaseStates,
} from "./control-plane-provider-account-leases.ts";

/** Provider/ProviderAccount/Command catalog delegators. */
export class ControlPlaneCatalogService {
  readonly state: ControlPlaneState;

  constructor(state: ControlPlaneState) {
    this.state = state;
  }
  createProvider(input: {
    id?: string;
    name: string;
    defaultCommandId?: string | null;
    usageRates?: UsageRates;
  }): { ok: true; provider: ProviderRecord } | { ok: false; error: string } {
    return providers.createProvider(this.state, input);
  }

  async createProviderDurable(input: {
    id?: string;
    name: string;
    defaultCommandId?: string | null;
    usageRates?: UsageRates;
  }): Promise<ReturnType<typeof providers.createProvider>> {
    return providers.createProviderDurable(this.state, input);
  }

  getProvider(id: string): ProviderRecord | null {
    return providers.getProvider(this.state, id);
  }

  getProviderDurable(id: string): Promise<ProviderRecord | null> {
    return durableCatalog.getProviderDurable(this.state, id);
  }

  listProviders(): ProviderRecord[] {
    return providers.listProviders(this.state);
  }

  async listProvidersDurable(): Promise<ProviderRecord[]> {
    await durableCatalog.listProvidersDurable(this.state);
    return providers.listProviders(this.state);
  }

  updateProvider(
    id: string,
    patch: Partial<{
      name: string;
      defaultCommandId: string | null;
      usageRates: UsageRates | null;
    }>,
  ): { ok: true; provider: ProviderRecord } | { ok: false; error: string } {
    return providers.updateProvider(this.state, id, patch);
  }

  async updateProviderDurable(
    id: string,
    patch: Partial<{
      name: string;
      defaultCommandId: string | null;
      usageRates: UsageRates | null;
    }>,
  ): Promise<ReturnType<typeof providers.updateProvider>> {
    return providers.updateProviderDurable(this.state, id, patch);
  }

  deleteProvider(id: string): { ok: true } | { ok: false; error: string } {
    return providers.deleteProvider(this.state, id);
  }

  async deleteProviderDurable(id: string): Promise<ReturnType<typeof providers.deleteProvider>> {
    return providers.deleteProviderDurable(this.state, id);
  }

  createProviderAccount(input: {
    id?: string;
    providerId: string;
    label: string;
    usageLimitCooldownSeconds?: number;
  }): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
    return providerAccounts.createProviderAccount(this.state, input);
  }

  async createProviderAccountDurable(input: {
    id?: string;
    providerId: string;
    label: string;
    usageLimitCooldownSeconds?: number;
  }): Promise<ReturnType<typeof providerAccounts.createProviderAccount>> {
    return durableProviderAccounts.createProviderAccountDurable(this.state, input);
  }

  getProviderAccount(id: string): ProviderAccountRecord | null {
    return providerAccounts.getProviderAccount(this.state, id);
  }

  getProviderAccountDurable(id: string): Promise<ProviderAccountRecord | null> {
    return durableCatalog.getProviderAccountDurable(this.state, id);
  }

  listProviderAccounts(): ProviderAccountRecord[] {
    return providerAccounts.listProviderAccounts(this.state);
  }

  async listProviderAccountsDurable(): Promise<ProviderAccountRecord[]> {
    await durableCatalog.listProviderAccountsDurable(this.state);
    return providerAccounts.listProviderAccounts(this.state);
  }

  updateProviderAccount(
    id: string,
    patch: Partial<{ providerId: string; label: string; usageLimitCooldownSeconds: number }>,
  ): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
    return providerAccounts.updateProviderAccount(this.state, id, patch);
  }

  async updateProviderAccountDurable(
    id: string,
    patch: Partial<{ providerId: string; label: string; usageLimitCooldownSeconds: number }>,
  ): Promise<ReturnType<typeof durableProviderAccounts.updateProviderAccountDurable>> {
    return durableProviderAccounts.updateProviderAccountDurable(this.state, id, patch);
  }

  clearProviderAccountUsageLimit(id: string) {
    return providerAccounts.clearProviderAccountUsageLimit(this.state, id);
  }

  async clearProviderAccountUsageLimitDurable(id: string) {
    return durableProviderAccounts.clearProviderAccountUsageLimitDurable(this.state, id);
  }

  deleteProviderAccount(id: string): { ok: true } | { ok: false; error: string } {
    return providerAccounts.deleteProviderAccount(this.state, id);
  }

  async deleteProviderAccountDurable(
    id: string,
  ): Promise<ReturnType<typeof providerAccounts.deleteProviderAccount>> {
    return durableProviderAccounts.deleteProviderAccountDurable(this.state, id);
  }

  listProviderAccountLeaseStatesDurable(id: string) {
    return listProviderAccountLeaseStates(this.state, id);
  }

  forceReleaseProviderAccountLeaseDurable(id: string, slot: number) {
    return forceReleaseProviderAccountLease(this.state, id, slot);
  }

  createCommand(
    input: CommandInput,
  ): { ok: true; command: CommandRecord } | { ok: false; error: string } {
    return commands.createCommand(this.state, input);
  }

  async createCommandDurable(
    input: CommandInput,
  ): Promise<ReturnType<typeof commands.createCommand>> {
    return commands.createCommandDurable(this.state, input);
  }

  getCommand(id: string): CommandRecord | null {
    return commands.getCommand(this.state, id);
  }

  getCommandDurable(id: string): Promise<CommandRecord | null> {
    return durableCatalog.getCommandDurable(this.state, id);
  }

  listCommands(): CommandRecord[] {
    return commands.listCommands(this.state);
  }

  async listCommandsDurable(): Promise<CommandRecord[]> {
    await durableCatalog.listCommandsDurable(this.state);
    return commands.listCommands(this.state);
  }

  updateCommand(
    id: string,
    patch: Partial<{
      name: string;
      argv: string[];
      appendPrompt: boolean;
      appendPromptSeparator: boolean;
      providerId: string | null;
      resumeArgvTemplate: string[] | null;
      resumeRefCapture: ResumeRefCapture | null;
    }>,
  ): { ok: true; command: CommandRecord } | { ok: false; error: string } {
    return commands.updateCommand(this.state, id, patch);
  }

  async updateCommandDurable(
    id: string,
    patch: Partial<{
      name: string;
      argv: string[];
      appendPrompt: boolean;
      appendPromptSeparator: boolean;
      providerId: string | null;
      resumeArgvTemplate: string[] | null;
      resumeRefCapture: ResumeRefCapture | null;
    }>,
  ): Promise<ReturnType<typeof commands.updateCommand>> {
    return commands.updateCommandDurable(this.state, id, patch);
  }

  deleteCommand(id: string): { ok: true } | { ok: false; error: string } {
    return commands.deleteCommand(this.state, id);
  }

  async deleteCommandDurable(id: string): Promise<ReturnType<typeof commands.deleteCommand>> {
    return durableCommands.deleteCommandDurable(this.state, id);
  }

  listSessionTargets(): SessionTarget[] {
    return listSessionTargets(this.state);
  }

  async listSessionTargetsDurable(): Promise<SessionTarget[]> {
    await durableRuntime.refreshSchedulerReadModel(this.state);
    await durableRuntime.listWorktreesDurable(this.state);
    return listSessionTargets(this.state);
  }
}
