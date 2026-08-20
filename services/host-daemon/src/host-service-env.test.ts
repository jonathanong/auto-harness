import { describe, expect, it } from "vitest";

import {
  applyEnvFile,
  envIdentityErrors,
  loadEnvFileIfPresent,
  parseEnvFile,
  pathFromEnv,
  renderEnvFile,
  warnOrRefuseIdentity,
} from "./host-service-env.ts";

const example = `# comment
PATH=/usr/bin
HARNESS_HOST_ID=REPLACE_WITH_BOUND_HOST_ID
HARNESS_API_URL=https://REPLACE_WITH_CONTROL_PLANE_URL
HARNESS_API_KEY=REPLACE_WITH_BOUND_SERVICE_ACCOUNT_KEY
HARNESS_CHILD_ENV_ALLOWLIST=
`;

describe("parseEnvFile / applyEnvFile", () => {
  it("skips comments and strips quotes", () => {
    expect(parseEnvFile(`# hi\nFOO=bar\nBAZ="quoted"\nQUUX='q'\n\nNOEQ\n`)).toEqual({
      FOO: "bar",
      BAZ: "quoted",
      QUUX: "q",
    });
  });

  it("fills missing keys without overriding existing values", () => {
    expect(
      applyEnvFile("HARNESS_HOST_ID=from-file\nHARNESS_API_KEY=from-file\n", {
        HARNESS_HOST_ID: "keep",
        HARNESS_API_KEY: "",
      }),
    ).toEqual({
      HARNESS_HOST_ID: "keep",
      HARNESS_API_KEY: "from-file",
    });
  });
});

describe("renderEnvFile", () => {
  it("fills identity from env and keeps comments", () => {
    const rendered = renderEnvFile(example, {
      HARNESS_HOST_ID: "host-1",
      HARNESS_API_URL: "https://d111.cloudfront.net",
      HARNESS_API_KEY: "secret",
      PATH: "/opt/homebrew/bin:/usr/bin",
    });
    expect(rendered).toContain("# comment");
    expect(rendered).toContain("HARNESS_HOST_ID=host-1");
    expect(rendered).toContain("HARNESS_API_URL=https://d111.cloudfront.net");
    expect(rendered).toContain("HARNESS_API_KEY=secret");
    expect(rendered).toContain("PATH=/opt/homebrew/bin:/usr/bin");
    expect(rendered.endsWith("\n")).toBe(true);
  });

  it("uses local defaults, HARNESS_API_HTTP, Path, and allowlisted extras", () => {
    const rendered = renderEnvFile(example, {
      HARNESS_API_HTTP: "http://127.0.0.1:7420",
      HARNESS_CHILD_ENV_ALLOWLIST: "GITHUB_TOKEN,HARNESS_SKIP,not valid",
      GITHUB_TOKEN: "gh",
      Path: "C:\\Windows",
    });
    expect(rendered).toContain("HARNESS_HOST_ID=local-1");
    expect(rendered).toContain("HARNESS_API_URL=http://127.0.0.1:7420");
    expect(rendered).toContain("HARNESS_API_KEY=\n");
    expect(rendered).toContain("GITHUB_TOKEN=gh");
    expect(rendered).not.toMatch(/^HARNESS_SKIP=/m);
    expect(rendered).not.toContain("GITHUB_TOKEN=gh\nGITHUB_TOKEN");
    expect(rendered).toContain("PATH=C:\\Windows");
    expect(renderEnvFile(example, { HARNESS_CHILD_ENV_ALLOWLIST: "GITHUB_TOKEN" })).not.toContain(
      "GITHUB_TOKEN=",
    );
    expect(renderEnvFile(example, { PATH: "/opt/homebrew/bin" }, { capturePath: false })).toContain(
      "PATH=/usr/bin",
    );
  });

  it("keeps an existing extra key and rejects multiline values", () => {
    const withExtra = `${example}GITHUB_TOKEN=old\n`;
    expect(
      renderEnvFile(withExtra, {
        HARNESS_CHILD_ENV_ALLOWLIST: "GITHUB_TOKEN",
        GITHUB_TOKEN: "new",
      }),
    ).toContain("GITHUB_TOKEN=new");
    expect(() => renderEnvFile(example, { HARNESS_HOST_ID: "a\nb" })).toThrow(/single line/);
    expect(() =>
      renderEnvFile(example, {
        HARNESS_CHILD_ENV_ALLOWLIST: "TOKEN",
        TOKEN: "a\nb",
      }),
    ).toThrow(/single line/);
  });

  it("pathFromEnv reads PATH then Path", () => {
    expect(pathFromEnv({ PATH: "/bin" })).toBe("/bin");
    expect(pathFromEnv({ Path: "C:\\Windows" })).toBe("C:\\Windows");
    expect(pathFromEnv({})).toBeUndefined();
  });

  it("envIdentityErrors flags linux local defaults and placeholders", () => {
    expect(envIdentityErrors({}, "linux")).toEqual([
      "HARNESS_HOST_ID",
      "HARNESS_API_URL",
      "HARNESS_API_KEY",
    ]);
    expect(
      envIdentityErrors(
        {
          HARNESS_HOST_ID: "local-1",
          HARNESS_API_URL: "http://127.0.0.1:7420",
          HARNESS_API_KEY: "",
        },
        "linux",
      ),
    ).toEqual(["HARNESS_HOST_ID", "HARNESS_API_URL", "HARNESS_API_KEY"]);
    expect(
      envIdentityErrors(
        {
          HARNESS_HOST_ID: "host-1",
          HARNESS_API_URL: "https://d111.cloudfront.net",
          HARNESS_API_KEY: "secret",
        },
        "linux",
      ),
    ).toEqual([]);
    expect(
      envIdentityErrors(
        {
          HARNESS_HOST_ID: "host-1",
          HARNESS_API_HTTP: "https://d111.cloudfront.net",
          HARNESS_API_KEY: "secret",
        },
        "linux",
      ),
    ).toEqual([]);
    expect(
      warnOrRefuseIdentity({
        env: {
          HARNESS_HOST_ID: "host-1",
          HARNESS_API_URL: "https://d111.cloudfront.net",
          HARNESS_API_KEY: "secret",
        },
        platform: "linux",
        error: () => undefined,
        log: () => undefined,
      }),
    ).toBe(0);
    const errors: string[] = [];
    const logs: string[] = [];
    expect(
      warnOrRefuseIdentity({
        env: { HARNESS_HOST_ID: "REPLACE_WITH_BOUND_HOST_ID" },
        platform: "linux",
        error: (m) => errors.push(m),
        log: (m) => logs.push(m),
      }),
    ).toBe(1);
    expect(errors.join("\n")).toMatch(/Refusing/);
    expect(
      warnOrRefuseIdentity({
        env: { HARNESS_HOST_ID: "host-1", HARNESS_API_URL: "https://x", HARNESS_API_KEY: "" },
        platform: "darwin",
        error: (m) => errors.push(m),
        log: (m) => logs.push(m),
      }),
    ).toBe(0);
    expect(logs.join("\n")).toMatch(/Warning/);
  });

  it("loadEnvFileIfPresent is a no-op without HARNESS_ENV_FILE", () => {
    expect(loadEnvFileIfPresent({ HARNESS_HOST_ID: "a" }, () => "X=1")).toEqual({
      HARNESS_HOST_ID: "a",
    });
    expect(loadEnvFileIfPresent({ HARNESS_ENV_FILE: " /e.env " }, () => "X=1\n")).toEqual({
      HARNESS_ENV_FILE: " /e.env ",
      X: "1",
    });
  });
});
