import { createHash, verify } from "node:crypto";

export type UpdateManifest = {
  version: string;
  artifactUrl: string;
  sha256: string;
  signature: string;
};

export type UpdateInstaller = {
  /**
   * `manifest` accompanies the artifact so a privileged Linux activation
   * helper can independently re-verify the signed bytes it promotes. Other
   * installers may ignore it.
   */
  stage(input: { version: string; artifact: Uint8Array; manifest?: UpdateManifest }): Promise<void>;
  activate(version: string): Promise<void>;
  restart(): Promise<void>;
  rollback(): Promise<void>;
};

export type UpdateLifecycle = {
  /** Resolve false when a pre-existing operator/policy drain was retained. */
  drain(): Promise<boolean | void>;
  waitForIdle(): Promise<void>;
  resume(): Promise<void>;
};

export type UpdateFetcher = {
  fetchManifest(): Promise<unknown>;
  fetchArtifact(url: string): Promise<Uint8Array>;
};

export type UpdateState =
  | { phase: "idle"; currentVersion: string }
  | { phase: "draining"; currentVersion: string; targetVersion: string }
  | { phase: "downloading"; currentVersion: string; targetVersion: string }
  | { phase: "staged"; currentVersion: string; targetVersion: string }
  | { phase: "restarting"; currentVersion: string; targetVersion: string }
  | { phase: "complete"; currentVersion: string }
  | { phase: "failed"; currentVersion: string; targetVersion?: string; error: string };

export type AgentUpdaterOptions = {
  currentVersion: string;
  manifestPublicKey: string;
  fetcher: UpdateFetcher;
  lifecycle: UpdateLifecycle;
  installer: UpdateInstaller;
  onState?: (state: UpdateState) => void;
};

export class AgentUpdater {
  private readonly options: AgentUpdaterOptions;
  private state: UpdateState;
  private running: Promise<UpdateState> | undefined;

  constructor(options: AgentUpdaterOptions) {
    this.options = options;
    this.state = { phase: "idle", currentVersion: options.currentVersion };
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  run(): Promise<UpdateState> {
    // A successful supervisor handoff ends this process's part of the
    // transaction. The replacement daemon confirms health from its own boot;
    // do not start a second activation while that durable acknowledgement is
    // still pending.
    if (this.state.phase === "restarting") return Promise.resolve(this.getState());
    if (this.running) return this.running;
    this.running = this.runOnce().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async runOnce(): Promise<UpdateState> {
    let targetVersion: string | undefined;
    let drained = false;
    let activated = false;
    const currentVersion = this.state.currentVersion;
    try {
      const manifest = parseAndVerifyManifest(
        await this.options.fetcher.fetchManifest(),
        this.options.manifestPublicKey,
      );
      targetVersion = manifest.version;
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        return this.transition({ phase: "complete", currentVersion });
      }
      this.transition({
        phase: "draining",
        currentVersion,
        targetVersion,
      });
      drained = (await this.options.lifecycle.drain()) !== false;
      await this.options.lifecycle.waitForIdle();
      this.transition({
        phase: "downloading",
        currentVersion,
        targetVersion,
      });
      const artifact = await this.options.fetcher.fetchArtifact(manifest.artifactUrl);
      if (sha256(artifact) !== manifest.sha256) throw new Error("artifact checksum mismatch");
      await this.options.installer.stage({ version: targetVersion, artifact, manifest });
      this.transition({
        phase: "staged",
        currentVersion,
        targetVersion,
      });
      await this.options.installer.activate(targetVersion);
      activated = true;
      this.transition({
        phase: "restarting",
        currentVersion,
        targetVersion,
      });
      await this.options.installer.restart();
      // `restart()` only requests a supervisor handoff. A durable boot marker
      // is acknowledged by the replacement daemon after it registers, so this
      // old process must never declare the update complete on its behalf.
      return this.getState();
    } catch (error) {
      let failure = error instanceof Error ? error.message : String(error);
      if (activated) {
        try {
          await this.options.installer.rollback();
        } catch (rollbackError) {
          failure += `; rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`;
        }
      }
      if (drained) {
        try {
          await this.options.lifecycle.resume();
        } catch (resumeError) {
          failure += `; resume failed: ${resumeError instanceof Error ? resumeError.message : String(resumeError)}`;
        }
      }
      return this.transition({
        phase: "failed",
        currentVersion,
        ...(targetVersion ? { targetVersion } : {}),
        error: failure,
      });
    }
  }

  private transition(state: UpdateState): UpdateState {
    this.state = state;
    try {
      this.options.onState?.(this.getState());
    } catch {
      // State observers are best-effort telemetry and must not control the update sequence.
    }
    return this.getState();
  }
}

export function parseAndVerifyManifest(input: unknown, publicKey: string): UpdateManifest {
  if (!isManifest(input)) throw new Error("invalid update manifest");
  const payload = canonicalManifest(input);
  const signature = Buffer.from(input.signature, "base64url");
  if (!verify(null, Buffer.from(payload), publicKey, signature)) {
    throw new Error("invalid update manifest signature");
  }
  return { ...input };
}

export function canonicalManifest(manifest: Omit<UpdateManifest, "signature">): string {
  return JSON.stringify({
    artifactUrl: manifest.artifactUrl,
    sha256: manifest.sha256,
    version: manifest.version,
  });
}

const sha256 = (artifact: Uint8Array) => createHash("sha256").update(artifact).digest("hex");

function isManifest(input: unknown): input is UpdateManifest {
  if (!input || typeof input !== "object") return false;
  const value = input as Record<string, unknown>;
  return (
    typeof value.version === "string" &&
    /^\d+\.\d+\.\d+$/.test(value.version) &&
    typeof value.artifactUrl === "string" &&
    value.artifactUrl.startsWith("https://") &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.signature === "string" &&
    value.signature.length > 0
  );
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(BigInt);
  const b = right.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index]! > b[index]!) return 1;
    if (a[index]! < b[index]!) return -1;
  }
  return 0;
}
