import { HarnessDispatchError } from "./errors.js";

export function requiredEnvironmentValue(environment, key) {
  const value = environment[key]?.trim();
  if (!value) throw new HarnessDispatchError("MISSING_ENVIRONMENT_VALUE", `${key} is required`);
  return value;
}
