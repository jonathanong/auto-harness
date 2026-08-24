/* eslint-disable max-lines -- platform supervisor templates are validated together. */
export const LINUX_ENV_DIR = "/etc/auto-harness";
export const LINUX_ENV_DEST = "/etc/auto-harness/host-daemon.env";
export const LINUX_UNIT_DEST = "/etc/systemd/system/auto-harness-host-daemon.service";
export const LINUX_OPT_CURRENT = "/opt/auto-harness/current";
/**
 * A root-owned entrypoint deliberately kept outside the daemon-writable
 * update root. `current` is selected by this script, so allowing the daemon
 * to replace the script would turn an update-root write into service command
 * replacement.
 */
export const LINUX_LAUNCHER_DEST = "/usr/local/lib/auto-harness/run-host-daemon.sh";
/** Root-owned verifier/promoter run by systemd before the daemon service. */
export const LINUX_ACTIVATION_HELPER_DEST =
  "/usr/local/lib/auto-harness/promote-host-daemon-update.mjs";
export const LINUX_SERVICE_NAME = "auto-harness-host-daemon.service";
export const LINUX_RELOAD_COMMAND = "systemctl daemon-reload";
export const LINUX_ENABLE_NOW_COMMAND = "systemctl enable --now auto-harness-host-daemon.service";

export const DARWIN_LABEL = "com.auto-harness.host-daemon";
export const WINDOWS_TASK_NAME = "AutoHarnessHostDaemon";

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function singleLine(value: string, label: string): void {
  if (/[\r\n]/.test(value)) throw new Error(`${label} must be a single line`);
}

function systemdArgument(value: string): string {
  singleLine(value, "systemd argument");
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function shellArgument(value: string): string {
  singleLine(value, "shell argument");
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

export function renderLinuxUnit(
  template: string,
  workingDirectory: string,
  launcherPath: string = LINUX_LAUNCHER_DEST,
): string {
  singleLine(workingDirectory, "WorkingDirectory");
  if (!/^WorkingDirectory=/m.test(template)) {
    throw new Error("unit template missing WorkingDirectory");
  }
  if (!/^ExecStart=/m.test(template)) throw new Error("unit template missing ExecStart");
  return template
    .replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${workingDirectory}`)
    .replace(/^ExecStart=.*$/m, `ExecStart=/bin/sh ${systemdArgument(launcherPath)}`);
}

/** A stable supervisor entrypoint that selects the atomically activated tree. */
export function renderUnixLaunchScript(opts: {
  nodePath: string;
  currentRoot: string;
  currentLauncherPath: string;
  fallbackRoot: string;
  fallbackLauncherPath: string;
}): string {
  return `#!/bin/sh
set -eu
if [ -f ${shellArgument(opts.currentLauncherPath)} ]; then
  cd ${shellArgument(opts.currentRoot)}
  exec ${shellArgument(opts.nodePath)} ${shellArgument(opts.currentLauncherPath)} start "$@"
fi
cd ${shellArgument(opts.fallbackRoot)}
exec ${shellArgument(opts.nodePath)} ${shellArgument(opts.fallbackLauncherPath)} start "$@"
`;
}

export function renderLaunchAgentPlist(opts: {
  nodePath: string;
  launcherPath: string;
  checkoutRoot: string;
  home: string;
  envFilePath: string;
  pathValue: string;
  logPath: string;
  programArguments?: readonly string[];
}): string {
  const s = (value: string) => `<string>${xmlEscape(value)}</string>`;
  const programArguments = opts.programArguments ?? [opts.nodePath, opts.launcherPath, "start"];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(DARWIN_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${programArguments.map(s).join("\n    ")}
  </array>
  <key>WorkingDirectory</key>
  ${s(opts.checkoutRoot)}
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    ${s(opts.home)}
    <key>PATH</key>
    ${s(opts.pathValue)}
    <key>HARNESS_ENV_FILE</key>
    ${s(opts.envFilePath)}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ExitTimeOut</key>
  <integer>900</integer>
  <key>StandardOutPath</key>
  ${s(opts.logPath)}
  <key>StandardErrorPath</key>
  ${s(opts.logPath)}
</dict>
</plist>
`;
}

export function renderWindowsLaunchCmd(opts: {
  nodePath: string;
  launcherPath: string;
  envFilePath: string;
  currentRoot: string;
  currentLauncherPath: string;
  fallbackRoot: string;
}): string {
  return `@echo off\r
set "HARNESS_ENV_FILE=${opts.envFilePath}"\r
if exist "${opts.currentLauncherPath}" (\r
  cd /d "${opts.currentRoot}"\r
  "${opts.nodePath}" "${opts.currentLauncherPath}" start\r
) else (\r
  cd /d "${opts.fallbackRoot}"\r
  "${opts.nodePath}" "${opts.launcherPath}" start\r
)\r
`;
}

export function windowsTaskRunCommand(cmdPath: string): string {
  return `cmd.exe /c "${cmdPath}"`;
}

export function windowsCreateTaskArgs(opts: { taskName: string; command: string }): string[] {
  return [
    "/Create",
    "/TN",
    opts.taskName,
    "/SC",
    "ONLOGON",
    "/RL",
    "LIMITED",
    "/IT",
    "/F",
    "/TR",
    opts.command,
  ];
}

export function windowsEndTaskArgs(taskName: string): string[] {
  return ["/End", "/TN", taskName];
}

export function windowsDeleteTaskArgs(taskName: string): string[] {
  return ["/Delete", "/TN", taskName, "/F"];
}

export function validateHostServiceArtifacts(input: {
  plist: string;
  windowsCmd: string;
  windowsCreateArgs: string[];
  linuxUnit: string;
}): string[] {
  const errors: string[] = [];
  const { plist, windowsCmd, windowsCreateArgs, linuxUnit } = input;
  for (const needle of [
    "com.auto-harness.host-daemon",
    "<key>RunAtLoad</key>",
    "<key>KeepAlive</key>",
    "<key>ExitTimeOut</key>",
    "<integer>900</integer>",
    "<key>HOME</key>",
    "HARNESS_ENV_FILE",
    "<string>start</string>",
  ]) {
    if (!plist.includes(needle)) errors.push(`missing plist fragment: ${needle}`);
  }
  if (/hns_[A-Za-z0-9_-]+/.test(plist)) {
    errors.push("plist contains a service-account-shaped secret");
  }
  if (/LOCALSYSTEM|NSSM|WinSW/i.test(plist)) {
    errors.push("plist uses a forbidden host identity or service wrapper");
  }
  if (!windowsCmd.includes("HARNESS_ENV_FILE")) {
    errors.push("windows cmd missing HARNESS_ENV_FILE");
  }
  if (!windowsCmd.includes("if exist")) {
    errors.push("windows cmd does not select activated current");
  }
  if (!windowsCmd.includes(" start")) {
    errors.push("windows cmd missing start");
  }
  if (/LOCALSYSTEM|NSSM|WinSW/i.test(windowsCmd)) {
    errors.push("windows cmd uses a forbidden host identity or service wrapper");
  }
  if (!windowsCreateArgs.includes("ONLOGON")) errors.push("scheduled task is not ONLOGON");
  if (!windowsCreateArgs.includes("LIMITED")) errors.push("scheduled task is not LIMITED");
  if (windowsCreateArgs.some((arg) => /SYSTEM/i.test(arg))) {
    errors.push("scheduled task runs as SYSTEM");
  }
  for (const needle of [
    "Type=notify",
    "NotifyAccess=main",
    "KillMode=mixed",
    "TimeoutStopSec=15min",
    "User=harness",
  ]) {
    if (!linuxUnit.includes(needle)) errors.push(`missing unit directive: ${needle}`);
  }
  return errors;
}

export function validateGeneratedHostServiceTemplates(linuxUnitTemplate: string): string[] {
  const plist = renderLaunchAgentPlist({
    nodePath: "/usr/local/bin/node",
    launcherPath: "/opt/checkout/services/host-daemon/bin/auto-harness-host-daemon.mjs",
    checkoutRoot: "/opt/checkout",
    home: "/Users/operator",
    envFilePath: "/Users/operator/Library/Application Support/auto-harness/host-daemon.env",
    pathValue: "/usr/local/bin:/usr/bin:/bin",
    logPath: "/Users/operator/Library/Logs/auto-harness-host-daemon.log",
  });
  const cmdPath = "C:\\Users\\operator\\AppData\\Roaming\\auto-harness\\run-host-daemon.cmd";
  const windowsCmd = renderWindowsLaunchCmd({
    nodePath: "C:\\Program Files\\nodejs\\node.exe",
    launcherPath: "C:\\checkout\\services\\host-daemon\\bin\\auto-harness-host-daemon.mjs",
    envFilePath: "C:\\Users\\operator\\AppData\\Roaming\\auto-harness\\host-daemon.env",
    currentRoot: "C:\\Users\\operator\\AppData\\Roaming\\auto-harness\\updates\\current",
    currentLauncherPath:
      "C:\\Users\\operator\\AppData\\Roaming\\auto-harness\\updates\\current\\services\\host-daemon\\bin\\auto-harness-host-daemon.mjs",
    fallbackRoot: "C:\\checkout",
  });
  const windowsCreateArgs = windowsCreateTaskArgs({
    taskName: WINDOWS_TASK_NAME,
    command: windowsTaskRunCommand(cmdPath),
  });
  const workingDirectory = "/home/operator/auto-harness";
  const linuxUnit = renderLinuxUnit(linuxUnitTemplate, workingDirectory);
  return [
    ...validateHostServiceArtifacts({
      plist,
      windowsCmd,
      windowsCreateArgs,
      linuxUnit,
    }),
    ...workingDirectoryErrors(linuxUnit, workingDirectory),
  ];
}

export function workingDirectoryErrors(unit: string, workingDirectory: string): string[] {
  if (unit.includes(`WorkingDirectory=${workingDirectory}`)) return [];
  return ["linux unit WorkingDirectory was not rewritten"];
}
