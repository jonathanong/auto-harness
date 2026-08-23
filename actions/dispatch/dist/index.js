const input = (name, required = false) => {
  const value = process.env[`INPUT_${name.replaceAll("-", "_").toUpperCase()}`]?.trim();
  if (required && !value) throw new Error(`Input required and not supplied: ${name}`);
  return value;
};

const parseJson = (name, value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${name} must be valid JSON`);
  }
};

const setOutput = (name, value) => {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is unavailable");
  appendFileSync(output, `${name}=${value}\n`, "utf8");
};

try {
  const baseUrl = input("server-url", true).replace(/\/$/, "").replace(/\/api\/v1$/, "");
  const body = {
    repositoryId: input("repository-id", true),
    prompt: input("prompt", true),
    target: parseJson("target", input("target", true)),
    ...(input("fallbacks") ? { fallbacks: parseJson("fallbacks", input("fallbacks")) } : {}),
    ...(input("ref") ? { ref: input("ref") } : {}),
    ...(input("concurrency-id") ? { concurrencyId: input("concurrency-id") } : {}),
    ...(input("metadata") ? { metadata: parseJson("metadata", input("metadata")) } : {}),
  };
  const response = await fetch(`${baseUrl}/api/v1/sessions`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: `Bearer ${input("api-key", true)}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error?.message ?? `Auto Harness returned ${response.status}`);
  setOutput("session-id", result.id);
  setOutput("session-url", result.url);
  setOutput("created", String(result.created));
  process.stdout.write(`Dispatched Auto Harness session ${result.id}\n`);
} catch (error) {
  process.stderr.write(`::error::${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
import { appendFileSync } from "node:fs";
