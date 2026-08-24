#!/bin/sh
set -eu

current=/opt/auto-harness/current
cd "$current"
exec /usr/bin/env node services/host-daemon/bin/auto-harness-host-daemon.mjs start "$@"
