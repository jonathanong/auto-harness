# Trusted setup scripts: do's and don'ts

Setup scripts are optional operator configuration for preparing a worktree before a fresh session.
Auto Harness does not inspect repository manifests or lockfiles, choose a package manager, or install
dependencies on its own. If no setup script is configured, the daemon checks out the assigned ref
and launches the assigned command without an additional preparation step.

Executable setup configuration is privileged and uses host exec-config with `fleet:exec-config` for
host-, repository-attachment-, and worktree-scoped setup. This is an admin-only
arbitrary-execution boundary. Repository catalog records also accept a `setupScript` field through
`catalog:write`, but current prompt and scheduled assignment paths do not send that catalog value to
the daemon; it is persisted metadata, not an executed setup surface. Configure supported setup on
the target host instead.

The configured script text is trusted operator policy, but the session checkout is not. A script
that invokes a file from the checkout, such as `./ci/session-setup`, deliberately lets the
checked-out ref control that part of execution.

## Execution contract

| Behavior          | Contract                                                                                                                                                                                  |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| When setup runs   | Fresh sessions only. Native resumes skip every setup script.                                                                                                                              |
| Order             | The host script runs first, followed by one scoped script using `session assignment > worktree > repository attachment` precedence.                                                       |
| Working directory | The claimed session worktree, or the locked main checkout for a scheduled session.                                                                                                        |
| Shell             | On POSIX hosts, an available absolute compatible `$SHELL` named `sh`, `bash`, `dash`, `ksh`, or `zsh`; otherwise `/bin/sh`. Configured setup is not currently supported on Windows hosts. |
| Environment       | Successful exports flow to the next setup script and form the assigned command's base environment, except reserved `HARNESS_*` values.                                                    |
| Output            | Every stdout/stderr chunk from setup is streamed into the live and retained session log. The private environment snapshot does not redact printed values.                                 |
| Failure           | A non-zero exit, timeout, cancellation, or invalid environment capture fails setup and prevents the assigned command from starting.                                                       |

For a session using a Provider Account, its execution profile is applied after setup: the profile
replaces `HOME`/`USERPROFILE` and overlays any colliding profile environment keys. The assigned
command can read the resulting final values, not necessarily every value setup originally exported.

Setup shares the session deadline and has a ten-minute cap. It may run again for another fresh
assignment, so it must tolerate repetition and partially prepared state.

## Do

- Leave setup unset when the checkout is already ready for the assigned command.
- Prefer small, reviewed, host-owned scripts outside repository worktrees. Use absolute paths and
  restrict their ownership and write permissions to trusted operators.
- Use absolute tool paths, or a `PATH` containing only absolute host-owned directories, when the
  exact executable matters.
- Keep setup idempotent. Check existing state before downloading, generating, resetting, or deleting
  anything.
- Treat every file read from the checkout as untrusted input, including manifests, lockfiles,
  package-manager configuration, environment files, executable scripts, and symlinks.
- Export only values the assigned CLI actually needs. Assume every non-`HARNESS_*` export becomes
  readable by repository work, unless a selected Provider Account execution profile replaces it.
- Disable shell tracing and keep credentials, tokens, environment dumps, and other secrets off
  stdout/stderr because setup output is retained in session logs.
- Put repository- and ecosystem-specific policy in the operator-owned script. Test it on every host
  operating system on which it will run.

For example, a host-owned executable can perform repository preparation without making Auto Harness
aware of the repository's toolchain:

```text
/opt/auto-harness/setup/repo-abc
```

If setup must export environment changes, source a reviewed host-owned file explicitly instead of a
broad interactive shell profile:

```text
. /opt/auto-harness/setup/host-environment
```

These paths are illustrative; use absolute, operator-controlled paths appropriate for the host.

## Don't

- Do not expect Auto Harness to detect Node.js, Rust, Python, Go, or another ecosystem and prepare it
  automatically.
- Do not source `.zshrc`, `.bashrc`, or another broad shell profile. It may export unrelated secrets
  to the assigned CLI.
- Do not invoke a checkout-owned setup script unless running code supplied by the assigned ref is an
  explicit and reviewed part of the policy.
- Do not put `.`, the session checkout, or another relative directory on `PATH`.
- Do not interpolate prompts, refs, metadata, or other caller-controlled strings into the setup shell
  program.
- Do not assume setup runs during native resume. A resumed command must use the existing worktree and
  environment it can establish without setup.
- Do not configure setup on a Windows host until native or compatible-shell setup execution is
  supported. Stock Windows has no usable `/bin/sh` fallback for this contract.
- Do not use destructive resets or cleanup against a scheduled main checkout unless that behavior is
  intentional, idempotent, and safe under the repository's maintenance policy.

## Package-manager boundary

Running a package manager from a trusted setup script is still an operator decision to process an
untrusted checkout. Depending on the ecosystem, checkout-controlled files may:

- select or download a toolchain or package-manager implementation;
- redirect caches, stores, state, or dependency paths outside the worktree;
- reference local directories through relative, linked, or file dependencies;
- redirect writes through symlinks; or
- start helper processes that outlive the setup command.

Auto Harness does not parse or sandbox those ecosystem-specific semantics. If dependency preparation
is required, the host-owned setup policy must choose the tool and version, constrain its environment
and filesystem access, and decide which checkout-controlled features are acceptable. Do not treat a
list of package-manager flags as a complete security boundary.

## Before saving setup configuration

- Is setup necessary, or can the host be prepared once during provisioning?
- Is every executable or sourced file operator-owned, or is checkout-controlled execution intended?
- Can any checkout file redirect reads, writes, downloads, or executable resolution?
- Are exported credentials and environment variables limited to what the assigned CLI needs?
- Can the script and every tool it invokes complete without printing secrets or enabling tracing?
- Is the script repeatable, bounded by the session deadline, and safe after a partial failure?
- Is the no-setup behavior for native resume acceptable?
- Has the exact script been tested on each target host operating system?

Implementation details and configuration examples live in [host-daemon.md](host-daemon.md#setup-scripts).
The broader host threat model and hardening guidance live in [security.md](security.md).
