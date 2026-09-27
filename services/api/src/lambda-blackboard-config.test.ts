import { ParameterNotFound } from "@aws-sdk/client-ssm";
import { expect, it, vi, afterEach } from "vitest";
import { loadBlackboardReporting } from "./lambda-handlers.ts";
import { config } from "../test-helpers/blackboard-reporting-fixtures.ts";
import { blackboardPolicy } from "./blackboard-config.ts";

afterEach(() => vi.unstubAllEnvs());

it("loads trusted reporting policy only through a decrypted SSM parameter", async () => {
  vi.stubEnv("HARNESS_BLACKBOARD_SSM_PARAM", "/harness/reporting");
  const send = vi.fn(async () => ({ Parameter: { Value: JSON.stringify(config()) } }));
  const reporting = await loadBlackboardReporting({ send });
  expect(blackboardPolicy(reporting?.config, "repo", "user:operator")?.repository).toBe(
    "owner/repo",
  );
  expect(send.mock.calls).toHaveLength(1);
  expect(send).toHaveBeenCalledWith(
    expect.objectContaining({ input: { Name: "/harness/reporting", WithDecryption: true } }),
  );
});

it("distinguishes absent policy from a transient SSM failure so cold starts can retry", async () => {
  vi.stubEnv("HARNESS_BLACKBOARD_SSM_PARAM", "");
  const absent = vi.fn(async () => {
    throw new Error("must not call");
  });
  expect(await loadBlackboardReporting({ send: absent })).toBeUndefined();
  expect(absent).not.toHaveBeenCalled();
  vi.stubEnv("HARNESS_BLACKBOARD_SSM_PARAM", "/harness/reporting");
  const missing = vi.fn(async () => {
    throw new ParameterNotFound({ message: "not provisioned", $metadata: {} });
  });
  expect(await loadBlackboardReporting({ send: missing })).toBeUndefined();
  const unavailable = vi.fn(async () => {
    throw new Error("KMS unavailable");
  });
  await expect(loadBlackboardReporting({ send: unavailable })).rejects.toThrow("KMS unavailable");
  const malformed = vi.fn(async () => ({ Parameter: { Value: "{}" } }));
  await expect(loadBlackboardReporting({ send: malformed })).rejects.toThrow();
});
