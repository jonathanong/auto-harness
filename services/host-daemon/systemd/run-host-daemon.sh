#!/bin/sh
set -eu

update_root=${HARNESS_UPDATE_INSTALL_DIR:-/opt/auto-harness}
current="$update_root/current"
cd "$current"
exec /usr/bin/env node services/host-daemon/bin/auto-harness-host-daemon.mjs start "$@"
