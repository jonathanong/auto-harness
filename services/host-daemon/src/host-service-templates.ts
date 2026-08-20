export const LINUX_ENV_DIR = "/etc/auto-harness";
export const LINUX_ENV_DEST = "/etc/auto-harness/host-daemon.env";
export const LINUX_UNIT_DEST = "/etc/systemd/system/auto-harness-host-daemon.service";
export const LINUX_OPT_CURRENT = "/opt/auto-harness/current";
export const LINUX_SERVICE_NAME = "auto-harness-host-daemon.service";
export const LINUX_RELOAD_COMMAND = "systemctl daemon-reload";
export const LINUX_ENABLE_NOW_COMMAND = "systemctl enable --now auto-harness-host-daemon.service";

export const DARWIN_LABEL = "com.auto-harness.host-daemon";
export const WINDOWS_TASK_NAME = "AutoHarnessHostDaemon";

export function xmlEscape(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function renderLinuxUnit(template: string, workingDirectory: string): string {
  if (/[\r\n]/.test(workingDirectory)) {
    throw new Error("WorkingDirectory must be a single line");
  }
  if (!/^WorkingDirectory=/m.test(template)) {
    throw new Error("unit template missing WorkingDirectory");
  }
  return template.replace(/^WorkingDirectory=.*$/m, `WorkingDirectory=${workingDirectory}`);
}

export function renderLaunchAgentPlist(opts: {
  nodePath: string;
  launcherPath: string;
  checkoutRoot: string;
  home: string;
  envFilePath: string;
  pathValue: string;
  logPath: string;
}): string {
  const s = (value: string) => `<string>${xmlEscape(value)}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${s(DARWIN_LABEL)}
  <key>ProgramArguments</key>
  <array>
    ${s(opts.nodePath)}
    ${s(opts.launcherPath)}
    ${s("start")}
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
}): string {
  return `@echo off\r
set "HARNESS_ENV_FILE=${opts.envFilePath}"\r
"${opts.nodePath}" "${opts.launcherPath}" start\r
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
  for (const needle of ["Type=simple", "KillMode=mixed", "TimeoutStopSec=15min", "User=harness"]) {
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
