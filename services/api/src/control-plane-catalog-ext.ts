import type { CommandRecord, ProviderAccountRecord, ProviderRecord } from "./db/plane-storage.ts";
import type { ResumeRefCapture } from "@auto-harness/shared";
import { ControlPlaneBase } from "./control-plane-facade.ts";
import * as commands from "./control-plane-commands.ts";
import type { CommandInput } from "./control-plane-commands.ts";
import * as providerAccounts from "./control-plane-provider-accounts.ts";
import * as providers from "./control-plane-providers.ts";
import { listSessionTargets, type SessionTarget } from "./control-plane-session-targets.ts";

/**
 * Provider/ProviderAccount/Command catalog delegators — split from
 * ControlPlaneBase/ControlPlane so neither breaks the max-lines budget.
 */
export class ControlPlaneCatalog extends ControlPlaneBase {
  createProvider(input: {
    id?: string;
    name: string;
    defaultCommandId?: string | null;
  }): { ok: true; provider: ProviderRecord } | { ok: false; error: string } {
    return providers.createProvider(this.state, input);
  }

  getProvider(id: string): ProviderRecord | null {
    return providers.getProvider(this.state, id);
  }

  listProviders(): ProviderRecord[] {
    return providers.listProviders(this.state);
  }

  updateProvider(
    id: string,
    patch: Partial<{ name: string; defaultCommandId: string | null }>,
  ): { ok: true; provider: ProviderRecord } | { ok: false; error: string } {
    return providers.updateProvider(this.state, id, patch);
  }

  deleteProvider(id: string): { ok: true } | { ok: false; error: string } {
    return providers.deleteProvider(this.state, id);
  }

  createProviderAccount(input: {
    id?: string;
    providerId: string;
    label: string;
    usageLimitCooldownSeconds?: number;
  }): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
    return providerAccounts.createProviderAccount(this.state, input);
  }

  getProviderAccount(id: string): ProviderAccountRecord | null {
    return providerAccounts.getProviderAccount(this.state, id);
  }

  listProviderAccounts(): ProviderAccountRecord[] {
    return providerAccounts.listProviderAccounts(this.state);
  }

  updateProviderAccount(
    id: string,
    patch: Partial<{ providerId: string; label: string; usageLimitCooldownSeconds: number }>,
  ): { ok: true; account: ProviderAccountRecord } | { ok: false; error: string } {
    return providerAccounts.updateProviderAccount(this.state, id, patch);
  }

  clearProviderAccountUsageLimit(id: string) {
    return providerAccounts.clearProviderAccountUsageLimit(this.state, id);
  }

  async clearProviderAccountUsageLimitDurable(id: string) {
    return providerAccounts.clearProviderAccountUsageLimitDurable(this.state, id);
  }

  deleteProviderAccount(id: string): { ok: true } | { ok: false; error: string } {
    return providerAccounts.deleteProviderAccount(this.state, id);
  }

  createCommand(
    input: CommandInput,
  ): { ok: true; command: CommandRecord } | { ok: false; error: string } {
    return commands.createCommand(this.state, input);
  }

  getCommand(id: string): CommandRecord | null {
    return commands.getCommand(this.state, id);
  }

  listCommands(): CommandRecord[] {
    return commands.listCommands(this.state);
  }

  updateCommand(
    id: string,
    patch: Partial<{
      name: string;
      argv: string[];
      appendPrompt: boolean;
      providerId: string | null;
      resumeArgvTemplate: string[] | null;
      resumeRefCapture: ResumeRefCapture | null;
    }>,
  ): { ok: true; command: CommandRecord } | { ok: false; error: string } {
    return commands.updateCommand(this.state, id, patch);
  }

  deleteCommand(id: string): { ok: true } | { ok: false; error: string } {
    return commands.deleteCommand(this.state, id);
  }

  listSessionTargets(): SessionTarget[] {
    return listSessionTargets(this.state);
  }
}
