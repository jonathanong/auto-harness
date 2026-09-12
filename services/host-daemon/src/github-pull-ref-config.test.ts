import { describe, expect, it } from "vitest";

import { GITHUB_PULL_REF_CONFIG_ENV, loadGitHubPullRefConfigs } from "./github-pull-ref-config.ts";

const configPath = "/etc/auto-harness/pull-refs.json";
const rootOwnedFile = { uid: 0, mode: 0o100644, isSymbolicLink: () => false };

function load(value: unknown) {
  return loadGitHubPullRefConfigs(
    { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
    () => JSON.stringify(value),
    () => rootOwnedFile,
  );
}

function repositoryConfig(overrides: Record<string, unknown> = {}) {
  return {
    repositories: {
      "/srv/repository": {
        remoteUrl: "https://github.example/repository.git",
        ...overrides,
      },
    },
  };
}

describe("GitHub pull-ref host policy", () => {
  it("treats an unset or whitespace-only policy path as no configured repositories", () => {
    for (const value of [undefined, "", " \t "]) {
      expect(loadGitHubPullRefConfigs({ [GITHUB_PULL_REF_CONFIG_ENV]: value })).toEqual(new Map());
    }
  });

  it("fails closed on Windows until native ACL immutability is verified", () => {
    expect(() =>
      loadGitHubPullRefConfigs(
        { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
        () => JSON.stringify(repositoryConfig()),
        () => rootOwnedFile,
        "win32",
      ),
    ).toThrow("unsupported on Windows");
  });

  it("loads a pinned repository URL and safe transport settings from an absolute host file", () => {
    const configs = loadGitHubPullRefConfigs(
      { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
      () =>
        JSON.stringify({
          repositories: {
            "/srv/repository": {
              remoteUrl: "https://github.example/repository.git",
              transport: {
                credentialHelper: "manager-core",
                httpProxy: "https://proxy.example",
                sslCAInfo: "/etc/ssl/private-ca.pem",
              },
            },
          },
        }),
      () => rootOwnedFile,
    );
    expect(configs.get("/srv/repository")).toEqual({
      remoteUrl: "https://github.example/repository.git",
      transport: {
        credentialHelper: "manager-core",
        httpProxy: "https://proxy.example",
        sslCAInfo: "/etc/ssl/private-ca.pem",
      },
    });
  });

  it("normalizes repository paths and permits an omitted transport block", () => {
    const configs = load({
      repositories: {
        "/srv/repository/../repository": {
          remoteUrl: "https://github.example/repository.git",
        },
      },
    });

    expect(configs.get("/srv/repository")).toEqual({
      remoteUrl: "https://github.example/repository.git",
      transport: {},
    });
  });

  it("rejects repository paths that normalize to the same policy key", () => {
    expect(() =>
      load({
        repositories: {
          "/srv/repository": { remoteUrl: "https://github.example/first.git" },
          "/srv/./repository": { remoteUrl: "https://github.example/second.git" },
        },
      }),
    ).toThrow("must not normalize to the same key");
  });

  it("retains only the individually configured safe transport settings", () => {
    for (const transport of [
      { credentialHelper: "manager-core" },
      { httpProxy: "https://proxy.example" },
      { sslCAInfo: "/etc/ssl/private-ca.pem" },
      {},
    ]) {
      const configs = load(repositoryConfig({ transport }));
      expect(configs.get("/srv/repository")?.transport).toEqual(transport);
    }
  });

  it("rejects invalid policy shapes and unrecognized keys", () => {
    const cases: ReadonlyArray<readonly [unknown, string]> = [
      [null, "GitHub pull-ref config must be an object"],
      [[], "GitHub pull-ref config must be an object"],
      ["policy", "GitHub pull-ref config must be an object"],
      [{ unexpected: true }, "GitHub pull-ref config has an unsupported key"],
      [{ repositories: null }, "GitHub pull-ref config.repositories must be an object"],
      [{ repositories: [] }, "GitHub pull-ref config.repositories must be an object"],
      [
        {
          repositories: { "relative/repository": { remoteUrl: "https://github.example/repo.git" } },
        },
        "GitHub pull-ref config repository path must be absolute",
      ],
      [
        { repositories: { "/srv/repository": null } },
        "GitHub pull-ref config.repositories./srv/repository must be an object",
      ],
      [
        repositoryConfig({ unexpected: true }),
        "GitHub pull-ref config.repositories./srv/repository has an unsupported key",
      ],
      [repositoryConfig({ remoteUrl: "" }), "remoteUrl must be a non-empty string"],
      [repositoryConfig({ remoteUrl: 123 }), "remoteUrl must be a non-empty string"],
      [repositoryConfig({ transport: null }), "transport must be an object"],
      [repositoryConfig({ transport: [] }), "transport must be an object"],
      [repositoryConfig({ transport: { urlInsteadOf: "https://attacker" } }), "unsupported key"],
    ];

    for (const [value, message] of cases) {
      expect(() => load(value)).toThrow(message);
    }
  });

  it("rejects relative files, unsafe helpers, malformed proxies, and relative CA paths", () => {
    expect(() =>
      loadGitHubPullRefConfigs({ [GITHUB_PULL_REF_CONFIG_ENV]: "pull-refs.json" }),
    ).toThrow("must be absolute");
    for (const transport of [
      { credentialHelper: "!curl attacker" },
      { credentialHelper: "" },
      { credentialHelper: 1 },
      { httpProxy: "not-a-url" },
      { httpProxy: "ftp://proxy.example" },
      { httpProxy: "https://username:password@proxy.example" },
      { httpProxy: "" },
      { httpProxy: 1 },
      { sslCAInfo: "private-ca.pem" },
      { sslCAInfo: "" },
      { sslCAInfo: 1 },
      { urlInsteadOf: "https://attacker" },
    ]) {
      expect(() =>
        loadGitHubPullRefConfigs(
          { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
          () =>
            JSON.stringify({
              repositories: {
                "/srv/repository": {
                  remoteUrl: "https://github.example/repository.git",
                  transport,
                },
              },
            }),
          () => rootOwnedFile,
        ),
      ).toThrow();
    }
  });

  it("requires a credential-free HTTPS remote URL", () => {
    for (const remoteUrl of [
      "git@github.com:example/repository.git",
      "ssh://github.com/example/repository.git",
      "http://github.com/example/repository.git",
      "https://token@github.com/example/repository.git",
      "not-a-url",
    ]) {
      expect(() => load(repositoryConfig({ remoteUrl }))).toThrow("remoteUrl must be an https URL");
    }
  });

  it("rejects symlinked, non-root-owned, and session-writable policy paths", () => {
    for (const [path, status, message] of [
      [configPath, { ...rootOwnedFile, isSymbolicLink: () => true }, "must not traverse symlinks"],
      ["/etc/auto-harness", { ...rootOwnedFile, uid: 501 }, "must be root-owned"],
      ["/etc", { ...rootOwnedFile, mode: 0o100664 }, "must be root-owned"],
    ] as const) {
      expect(() =>
        loadGitHubPullRefConfigs(
          { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
          () => JSON.stringify(repositoryConfig()),
          (candidate) => (candidate === path ? status : rootOwnedFile),
        ),
      ).toThrow(message);
    }
  });
});
