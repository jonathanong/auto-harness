import { appendFileSync } from "node:fs";

export function input(name: string, required = false): string {
  const value = process.env[`INPUT_${name.replaceAll("-", "_").toUpperCase()}`]?.trim() ?? "";
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
}

export function parseJson<T>(name: string, value: string, fallback?: T): T {
  if (!value && fallback !== undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
}

function parsePositiveNumber(name: string, raw: string, maximum?: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0 || (maximum !== undefined && value > maximum)) {
    throw new Error(
      maximum === undefined
        ? `${name} must be a positive number`
        : `${name} must be a finite positive number no greater than ${maximum}`,
    );
  }
  return value;
}

export function positiveNumberInput(name: string, maximum?: number): number {
  return parsePositiveNumber(name, input(name, true), maximum);
}

export function optionalPositiveNumberInput(name: string, maximum?: number): number | undefined {
  const raw = input(name);
  return raw ? parsePositiveNumber(name, raw, maximum) : undefined;
}

export function optionalBoundedNumberInput(
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  const raw = input(name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be a finite number between ${minimum} and ${maximum}`);
  }
  return value;
}

export function requestTimeoutMs(): number {
  const value = Number(input("request-timeout-seconds") || "30");
  if (!Number.isFinite(value) || value <= 0 || value > 300) {
    throw new Error("request-timeout-seconds must be a finite positive number no greater than 300");
  }
  return value * 1_000;
}

export function setOutput(name: string, value: string): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable");
  appendFileSync(output, `${name}=${value}\n`, "utf8");
}

export function escapeWorkflowCommand(value: string): string {
  return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
