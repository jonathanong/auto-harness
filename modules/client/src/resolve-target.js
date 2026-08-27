import { AutoHarnessError } from "./errors.js";

async function resolveRef(ref, providers, commands) {
  if (ref == null || typeof ref !== "object") return ref;
  if ("providerId" in ref || "commandId" in ref) return ref;
  if ("providerName" in ref) {
    const match = (await providers()).find((provider) => provider.name === ref.providerName);
    if (!match) {
      throw new AutoHarnessError(`no provider named "${ref.providerName}"`, {
        status: 400,
        code: "UNKNOWN_PROVIDER_NAME",
      });
    }
    return { providerId: match.id };
  }
  if ("commandName" in ref) {
    const matches = (await commands()).filter((command) => command.name === ref.commandName);
    if (matches.length === 0) {
      throw new AutoHarnessError(`no command named "${ref.commandName}"`, {
        status: 400,
        code: "UNKNOWN_COMMAND_NAME",
      });
    }
    if (matches.length > 1) {
      throw new AutoHarnessError(
        `ambiguous command name "${ref.commandName}": ${matches.length} commands share this name`,
        { status: 400, code: "AMBIGUOUS_COMMAND_NAME" },
      );
    }
    return { commandId: matches[0].id };
  }
  return ref;
}

/**
 * Resolves `providerName`/`commandName` entries in `input.target`/`input.fallbacks` to
 * `providerId`/`commandId` via `client.listProviders()`/`listCommands()`, called at most once
 * each regardless of how many refs need them. Id-shaped refs pass through untouched, so an
 * all-id call makes no extra requests.
 */
export async function resolveCreateSessionTargets(client, input) {
  let providersPromise;
  let commandsPromise;
  const providers = () => (providersPromise ??= client.listProviders());
  const commands = () => (commandsPromise ??= client.listCommands());

  const target = await resolveRef(input.target, providers, commands);
  if (input.fallbacks === undefined) return { ...input, target };
  const fallbacks = await Promise.all(
    input.fallbacks.map((fallback) => resolveRef(fallback, providers, commands)),
  );
  return { ...input, target, fallbacks };
}
