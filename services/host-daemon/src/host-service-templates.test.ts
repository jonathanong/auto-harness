import { describe, expect, it } from "vitest";

import {
  renderLaunchAgentPlist,
  renderLinuxUnit,
  renderUnixLaunchScript,
  renderWindowsLaunchCmd,
  validateGeneratedHostServiceTemplates,
  validateHostServiceArtifacts,
  workingDirectoryErrors,
  windowsCreateTaskArgs,
  windowsDeleteTaskArgs,
  windowsEndTaskArgs,
  windowsTaskRunCommand,
  xmlEscape,
} from "./host-service-templates.ts";

const unitTemplate = `[Service]
Type=notify
NotifyAccess=main
User=harness
WorkingDirectory=/opt/auto-harness/current
ExecStart=/usr/bin/env node services/host-daemon/bin/auto-harness-host-daemon.mjs start
TimeoutStopSec=15min
KillMode=mixed
`;

describe("linux unit rendering", () => {
  it("rewrites WorkingDirectory and rejects unsafe values", () => {
    expect(renderLinuxUnit(unitTemplate, "/home/op/src")).toContain(
      "WorkingDirectory=/home/op/src",
    );
    expect(renderLinuxUnit(unitTemplate, "/home/op/src")).toContain(
      'ExecStart=/bin/sh "/usr/local/lib/auto-harness/run-host-daemon.sh"',
    );
    expect(renderLinuxUnit(unitTemplate, "/home/op/src")).toContain("Type=notify");
    expect(() => renderLinuxUnit(unitTemplate, "/tmp\nEvil=1")).toThrow(/single line/);
    expect(() => renderLinuxUnit("Type=notify\n", "/tmp")).toThrow(/WorkingDirectory/);
  });
});

describe("launchd plist / windows cmd", () => {
  it("escapes XML and keeps HOME plus env-file, not secrets", () => {
    const plist = renderLaunchAgentPlist({
      nodePath: "/usr/bin/node",
      launcherPath: "/repo/services/host-daemon/bin/auto-harness-host-daemon.mjs",
      checkoutRoot: "/repo",
      home: "/Users/op & co",
      envFilePath: "/Users/op/Library/Application Support/auto-harness/host-daemon.env",
      pathValue: "/usr/bin",
      logPath: "/Users/op/Library/Logs/auto-harness-host-daemon.log",
    });
    expect(plist).toContain("<string>/Users/op &amp; co</string>");
    expect(plist).toContain("<key>HOME</key>");
    expect(plist).toContain("<key>ExitTimeOut</key>");
    expect(plist).toContain("<integer>900</integer>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).not.toMatch(/hns_/);
    expect(xmlEscape("a<b>c")).toBe("a&lt;b&gt;c");
  });

  it("builds a current-user logon task without SYSTEM wrappers", () => {
    const cmd = renderWindowsLaunchCmd({
      nodePath: "C:\\Program Files\\nodejs\\node.exe",
      launcherPath: "C:\\repo\\services\\host-daemon\\bin\\auto-harness-host-daemon.mjs",
      envFilePath: "C:\\Users\\op\\AppData\\Roaming\\auto-harness\\host-daemon.env",
      currentRoot: "C:\\Users\\op\\AppData\\Roaming\\auto-harness\\updates\\current",
      currentLauncherPath:
        "C:\\Users\\op\\AppData\\Roaming\\auto-harness\\updates\\current\\services\\host-daemon\\bin\\auto-harness-host-daemon.mjs",
      fallbackRoot: "C:\\repo",
      prepareLauncherPath: "C:\\repo\\services\\host-daemon\\bin\\auto-harness-host-daemon.mjs",
    });
    expect(cmd).toContain("HARNESS_ENV_FILE=");
    expect(cmd).toContain("prepare-update-boot");
    expect(cmd).toContain("if errorlevel 1 exit /b %errorlevel%");
    expect(cmd.indexOf("prepare-update-boot")).toBeLessThan(cmd.indexOf("if exist"));
    expect(cmd).toContain("if exist");
    expect(cmd).toContain(" start");
    const args = windowsCreateTaskArgs({
      taskName: "AutoHarnessHostDaemon",
      command: windowsTaskRunCommand(
        "C:\\Users\\op\\AppData\\Roaming\\auto-harness\\run-host-daemon.cmd",
      ),
    });
    expect(args).toEqual(expect.arrayContaining(["/SC", "ONLOGON", "/RL", "LIMITED", "/IT", "/F"]));
    expect(args.join(" ")).not.toMatch(/LOCALSYSTEM|NSSM|WinSW/i);
    expect(windowsEndTaskArgs("AutoHarnessHostDaemon")).toEqual([
      "/End",
      "/TN",
      "AutoHarnessHostDaemon",
    ]);
    expect(windowsDeleteTaskArgs("AutoHarnessHostDaemon")).toEqual([
      "/Delete",
      "/TN",
      "AutoHarnessHostDaemon",
      "/F",
    ]);
  });

  it("keeps a Unix supervisor launcher outside the activated tree", () => {
    const launcher = renderUnixLaunchScript({
      currentRoot: "/updates/current",
      currentLauncherPath: "/updates/current/services/host-daemon/bin/auto-harness-host-daemon.mjs",
      fallbackRoot: "/checkout",
      fallbackLauncherPath: "/checkout/services/host-daemon/bin/auto-harness-host-daemon.mjs",
      prepareLauncherPath: "/checkout/services/host-daemon/bin/auto-harness-host-daemon.mjs",
    });
    expect(launcher).toContain("prepare-update-boot");
    expect(launcher.indexOf("prepare-update-boot")).toBeLessThan(launcher.indexOf("if [ -f"));
    expect(launcher).toContain(
      "if [ -f '/updates/current/services/host-daemon/bin/auto-harness-host-daemon.mjs' ]",
    );
    expect(launcher).toContain("cd '/updates/current'");
    expect(launcher).toContain("cd '/checkout'");
    expect(launcher).toContain('start "$@"');
  });

  it("resolves node via PATH instead of baking in an absolute interpreter path", () => {
    const launcher = renderUnixLaunchScript({
      currentRoot: "/updates/current",
      currentLauncherPath: "/updates/current/services/host-daemon/bin/auto-harness-host-daemon.mjs",
      fallbackRoot: "/checkout",
      fallbackLauncherPath: "/checkout/services/host-daemon/bin/auto-harness-host-daemon.mjs",
      prepareLauncherPath: "/checkout/services/host-daemon/bin/auto-harness-host-daemon.mjs",
    });
    expect(launcher).toContain(
      "node '/checkout/services/host-daemon/bin/auto-harness-host-daemon.mjs' prepare-update-boot",
    );
    expect(launcher).toContain(
      "exec node '/updates/current/services/host-daemon/bin/auto-harness-host-daemon.mjs' start",
    );
    expect(launcher).toContain(
      "exec node '/checkout/services/host-daemon/bin/auto-harness-host-daemon.mjs' start",
    );
    expect(launcher).not.toMatch(/'\/[^']*\/node'/);
  });
});

describe("template contract", () => {
  it("accepts generated artifacts", () => {
    expect(validateGeneratedHostServiceTemplates(unitTemplate)).toEqual([]);
  });

  it("reports missing fragments and forbidden wrappers", () => {
    expect(
      validateHostServiceArtifacts({
        plist: "LOCALSYSTEM NSSM hns_abc",
        windowsCmd: "nssm LOCALSYSTEM",
        windowsCreateArgs: ["LOCALSYSTEM"],
        linuxUnit: "Type=simple\n",
      }),
    ).toEqual(
      expect.arrayContaining([
        "missing plist fragment: com.auto-harness.host-daemon",
        "missing plist fragment: <key>ExitTimeOut</key>",
        "missing plist fragment: <integer>900</integer>",
        "plist contains a service-account-shaped secret",
        "plist uses a forbidden host identity or service wrapper",
        "windows cmd missing HARNESS_ENV_FILE",
        "windows cmd missing start",
        "windows cmd uses a forbidden host identity or service wrapper",
        "scheduled task is not ONLOGON",
        "scheduled task is not LIMITED",
        "scheduled task runs as SYSTEM",
        "missing unit directive: Type=notify",
      ]),
    );
  });

  it("flags a unit that lost drain semantics after rewrite", () => {
    expect(
      validateGeneratedHostServiceTemplates(
        "WorkingDirectory=/opt/auto-harness/current\nExecStart=/old/daemon start\n",
      ),
    ).toEqual(expect.arrayContaining(["missing unit directive: Type=notify"]));
    expect(
      workingDirectoryErrors("WorkingDirectory=/other\n", "/home/operator/auto-harness"),
    ).toEqual(["linux unit WorkingDirectory was not rewritten"]);
    expect(workingDirectoryErrors("WorkingDirectory=/tmp\n", "/tmp")).toEqual([]);
  });
});
