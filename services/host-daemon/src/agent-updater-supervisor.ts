import { restartHostService, type HostServiceOpts } from "./host-service.ts";
import type { UpdateInstaller } from "./agent-updater.ts";

export function createSupervisorRestartInstaller(
  installer: Omit<UpdateInstaller, "restart">,
  service: HostServiceOpts,
): UpdateInstaller {
  return {
    stage: (input) => installer.stage(input),
    activate: (version) => installer.activate(version),
    rollback: () => installer.rollback(),
    async restart() {
      const status = restartHostService(service);
      if (status !== 0) throw new Error("supervisor restart failed");
    },
  };
}
