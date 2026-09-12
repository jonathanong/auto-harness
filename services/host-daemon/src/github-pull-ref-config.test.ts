import { describe, expect, it } from "vitest";

import { GITHUB_PULL_REF_CONFIG_ENV, loadGitHubPullRefConfigs } from "./github-pull-ref-config.ts";

describe("GitHub pull-ref host policy", () => {
  it("loads a pinned repository URL and safe transport settings from an absolute host file", () => {
    const configs = loadGitHubPullRefConfigs(
      { [GITHUB_PULL_REF_CONFIG_ENV]: "/etc/auto-harness/pull-refs.json" },
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

  it("rejects relative files, URL rewrites, shell helpers, and relative CA paths", () => {
    expect(() =>
      loadGitHubPullRefConfigs({ [GITHUB_PULL_REF_CONFIG_ENV]: "pull-refs.json" }),
    ).toThrow("must be absolute");
    for (const transport of [
      { credentialHelper: "!curl attacker" },
      { sslCAInfo: "private-ca.pem" },
      { urlInsteadOf: "https://attacker" },
    ]) {
      expect(() =>
        loadGitHubPullRefConfigs(
          { [GITHUB_PULL_REF_CONFIG_ENV]: "/etc/auto-harness/pull-refs.json" },
          () =>
            JSON.stringify({
              repositories: {
                "/srv/repository": {
                  remoteUrl: "https://github.example/repository.git",
                  transport,
                },
              },
            }),
        ),
      ).toThrow();
    }
  });
});
