/* eslint-disable max-lines -- parser policy cases share one immutable filesystem fixture. */
import { describe, expect, it } from "vitest";
import { join } from "node:path";

import { GITHUB_PULL_REF_CONFIG_ENV, loadGitHubPullRefConfigs } from "./github-pull-ref-config.ts";

const configPath = "/etc/auto-harness/pull-refs.json";
const rootOwnedFile = {
  uid: 0,
  mode: 0o100444,
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
};
const rootOwnedDirectory = {
  uid: 0,
  mode: 0o40555,
  isDirectory: () => true,
  isFile: () => false,
  isSymbolicLink: () => false,
};
const rootOwnedExecutable = {
  uid: 0,
  mode: 0o100555,
  isDirectory: () => false,
  isFile: () => true,
  isSymbolicLink: () => false,
};
const materializerGitDirs = {
  sha1: "/etc/auto-harness/pull-ref-materializers/sha1.git",
  sha256: "/etc/auto-harness/pull-ref-materializers/sha256.git",
};

function inspectPolicyPath(path: string) {
  if (path.startsWith("/usr/bin/git-credential-")) return rootOwnedExecutable;
  if (path === configPath || path.endsWith("/config")) return rootOwnedFile;
  return rootOwnedDirectory;
}

function resolveCredentialHelper(command: string): string {
  return join("/usr/bin", command);
}

function readPolicyDirectory(path: string): string[] {
  return path === materializerGitDirs.sha1 || path === materializerGitDirs.sha256
    ? ["config", "info"]
    : [];
}

function load(value: unknown) {
  return loadGitHubPullRefConfigs(
    { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
    () => JSON.stringify(value),
    inspectPolicyPath,
    "linux",
    readPolicyDirectory,
    resolveCredentialHelper,
  );
}

function repositoryConfig(overrides: Record<string, unknown> = {}) {
  return {
    materializerGitDirs,
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
        inspectPolicyPath,
        "win32",
      ),
    ).toThrow("unsupported on Windows");
  });

  it("loads a pinned repository URL and safe transport settings from an absolute host file", () => {
    const configs = loadGitHubPullRefConfigs(
      { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
      () =>
        JSON.stringify({
          materializerGitDirs,
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
      inspectPolicyPath,
      "linux",
      readPolicyDirectory,
      resolveCredentialHelper,
    );
    expect(configs.get("/srv/repository")).toEqual({
      materializerGitDirs,
      remoteUrl: "https://github.example/repository.git",
      transport: {
        credentialHelper: "/usr/bin/git-credential-manager-core",
        httpProxy: "https://proxy.example/",
        sslCAInfo: "/etc/ssl/private-ca.pem",
      },
    });
  });

  it("normalizes repository paths and permits an omitted transport block", () => {
    const configs = load({
      materializerGitDirs,
      repositories: {
        "/srv/repository/../repository": {
          remoteUrl: "https://github.example/repository.git",
        },
      },
    });

    expect(configs.get("/srv/repository")).toEqual({
      materializerGitDirs,
      remoteUrl: "https://github.example/repository.git",
      transport: {},
    });
  });

  it("rejects repository paths that normalize to the same policy key", () => {
    expect(() =>
      load({
        materializerGitDirs,
        repositories: {
          "/srv/repository": { remoteUrl: "https://github.example/first.git" },
          "/srv/./repository": { remoteUrl: "https://github.example/second.git" },
        },
      }),
    ).toThrow("must not normalize to the same key");
  });

  it("retains only the individually configured safe transport settings", () => {
    for (const [transport, expected] of [
      [
        { credentialHelper: "manager-core" },
        { credentialHelper: "/usr/bin/git-credential-manager-core" },
      ],
      [{ httpProxy: "https://proxy.example" }, { httpProxy: "https://proxy.example/" }],
      [{ sslCAInfo: "/etc/ssl/private-ca.pem" }, { sslCAInfo: "/etc/ssl/private-ca.pem" }],
      [{}, {}],
    ] as const) {
      const configs = load(repositoryConfig({ transport }));
      expect(configs.get("/srv/repository")?.transport).toEqual(expected);
    }
  });

  it("pins a configured credential helper to its immutable administrator-owned executable", () => {
    const configs = load(repositoryConfig({ transport: { credentialHelper: "manager-core" } }));
    expect(configs.get("/srv/repository")?.transport.credentialHelper).toBe(
      "/usr/bin/git-credential-manager-core",
    );
  });

  it("rejects credential helpers that cannot be pinned to an immutable executable", () => {
    expect(() =>
      loadGitHubPullRefConfigs(
        { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
        () => JSON.stringify(repositoryConfig({ transport: { credentialHelper: "manager-core" } })),
        inspectPolicyPath,
        "linux",
        readPolicyDirectory,
        () => {
          throw new Error("not found");
        },
      ),
    ).toThrow("must resolve to an immutable executable");

    expect(() =>
      loadGitHubPullRefConfigs(
        { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
        () => JSON.stringify(repositoryConfig({ transport: { credentialHelper: "manager-core" } })),
        inspectPolicyPath,
        "linux",
        readPolicyDirectory,
        () => {
          throw { reason: "not found" };
        },
      ),
    ).toThrow("must resolve to an immutable executable");

    expect(() =>
      loadGitHubPullRefConfigs(
        { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
        () => JSON.stringify(repositoryConfig({ transport: { credentialHelper: "manager-core" } })),
        inspectPolicyPath,
        "linux",
        readPolicyDirectory,
        () => "git-credential-manager-core",
      ),
    ).toThrow("must resolve to an absolute executable");

    for (const status of [
      { ...rootOwnedExecutable, isSymbolicLink: () => true },
      { ...rootOwnedExecutable, isFile: () => false },
      { ...rootOwnedExecutable, uid: 501 },
      { ...rootOwnedExecutable, mode: 0o100755 },
      { ...rootOwnedExecutable, mode: 0o100444 },
    ]) {
      let helperInspectionCount = 0;
      expect(() =>
        loadGitHubPullRefConfigs(
          { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
          () =>
            JSON.stringify(repositoryConfig({ transport: { credentialHelper: "manager-core" } })),
          (path) => {
            if (path.startsWith("/usr/bin/git-credential-")) {
              return helperInspectionCount++ === 0 ? rootOwnedExecutable : status;
            }
            return inspectPolicyPath(path);
          },
          "linux",
          readPolicyDirectory,
          resolveCredentialHelper,
        ),
      ).toThrow();
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
          materializerGitDirs,
          repositories: { "relative/repository": { remoteUrl: "https://github.example/repo.git" } },
        },
        "GitHub pull-ref config repository path must be absolute",
      ],
      [
        { materializerGitDirs, repositories: { "/srv/repository": null } },
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

  it("requires immutable bare materializers for both supported object formats", () => {
    for (const [dirs, message] of [
      [undefined, "materializerGitDirs must be an object"],
      [{ sha1: materializerGitDirs.sha1 }, "materializerGitDirs.sha256 must be a non-empty string"],
      [
        { ...materializerGitDirs, sha256: "relative.git" },
        "materializerGitDirs.sha256 must be absolute",
      ],
      [{ ...materializerGitDirs, md5: "/etc/auto-harness/md5.git" }, "unsupported key"],
    ] as const) {
      expect(() => load({ ...repositoryConfig(), materializerGitDirs: dirs })).toThrow(message);
    }
  });

  it("rejects symlinked, writable, non-directory, and writable-descendant materializers", () => {
    const cases: ReadonlyArray<
      readonly [
        string,
        (path: string) => typeof rootOwnedFile | typeof rootOwnedDirectory,
        (path: string) => string[],
        string,
      ]
    > = [
      [
        "symlinked",
        (path) =>
          path === materializerGitDirs.sha1
            ? { ...rootOwnedDirectory, isSymbolicLink: () => true }
            : inspectPolicyPath(path),
        readPolicyDirectory,
        "must not traverse symlinks",
      ],
      [
        "writable",
        (path) =>
          path === materializerGitDirs.sha1
            ? { ...rootOwnedDirectory, mode: 0o40755 }
            : inspectPolicyPath(path),
        readPolicyDirectory,
        "materializerGitDirs.sha1",
      ],
      [
        "not a directory",
        (path) => (path === materializerGitDirs.sha1 ? rootOwnedFile : inspectPolicyPath(path)),
        readPolicyDirectory,
        "materializerGitDirs.sha1",
      ],
      [
        "non-regular config",
        (path) =>
          path === join(materializerGitDirs.sha1, "config")
            ? rootOwnedDirectory
            : inspectPolicyPath(path),
        readPolicyDirectory,
        "materializerGitDirs.sha1/config",
      ],
      [
        "non-regular descendant",
        (path) =>
          path === join(materializerGitDirs.sha1, "unsupported")
            ? { ...rootOwnedFile, isFile: () => false }
            : inspectPolicyPath(path),
        (path) => (path === materializerGitDirs.sha1 ? ["config", "unsupported"] : []),
        "must contain only regular files and directories",
      ],
      [
        "writable attributes descendant",
        (path) =>
          path === join(materializerGitDirs.sha1, "info", "attributes")
            ? { ...rootOwnedFile, mode: 0o100644 }
            : inspectPolicyPath(path),
        (path) =>
          path === materializerGitDirs.sha1
            ? ["config", "info"]
            : path === join(materializerGitDirs.sha1, "info")
              ? ["attributes"]
              : [],
        "materializerGitDirs.sha1",
      ],
    ];
    for (const [_description, inspect, readDirectory, message] of cases) {
      expect(() =>
        loadGitHubPullRefConfigs(
          { [GITHUB_PULL_REF_CONFIG_ENV]: configPath },
          () => JSON.stringify(repositoryConfig()),
          inspect,
          "linux",
          readDirectory,
        ),
      ).toThrow(message);
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
      { httpProxy: "https://proxy.example?token=secret" },
      { httpProxy: "https://proxy.example#credentials" },
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
              materializerGitDirs,
              repositories: {
                "/srv/repository": {
                  remoteUrl: "https://github.example/repository.git",
                  transport,
                },
              },
            }),
          inspectPolicyPath,
          "linux",
          readPolicyDirectory,
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
      "https://github.com/example/repository.git?ref=main",
      "https://github.com/example/repository.git#main",
      "not-a-url",
    ]) {
      expect(() => load(repositoryConfig({ remoteUrl }))).toThrow("remoteUrl must be an https URL");
    }
  });

  it("canonicalizes HTTPS URL spellings before Git receives the transport operand", () => {
    const remoteUrl = String.raw`https:\\github.example\repository.git`;
    expect(load(repositoryConfig({ remoteUrl })).get("/srv/repository")?.remoteUrl).toBe(
      "https://github.example/repository.git",
    );
  });

  it("canonicalizes httpProxy spellings before Git receives the transport operand", () => {
    const httpProxy = String.raw`https:\\proxy.example`;
    const configs = load(repositoryConfig({ transport: { httpProxy } }));
    expect(configs.get("/srv/repository")?.transport.httpProxy).toBe("https://proxy.example/");
    expect(["-c", `http.proxy=${configs.get("/srv/repository")?.transport.httpProxy}`]).toEqual([
      "-c",
      "http.proxy=https://proxy.example/",
    ]);
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
