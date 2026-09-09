#!/bin/bash
# wait -n is a bashism; dash (the container's /bin/sh) doesn't support it.
# dsh web refuses --host 0.0.0.0 by design (it would expose remote code
# execution to the network, see apps/cli's arg parser). It only binds
# 127.0.0.1 *inside the container's own network namespace*, which Docker's
# published ports cannot reach directly. socat bridges that: it listens on
# every interface at DSH_WEB_INTERNAL_PROXY_PORT and forwards to dsh's real
# 127.0.0.1:DSH_WEB_INTERNAL_PORT. The only way in from there is the
# ADMIN_EMAIL/ADMIN_PASSWORD login dsh web itself enforces.
set -eu

: "${DSH_WEB_INTERNAL_PORT:=3080}"
: "${DSH_WEB_INTERNAL_PROXY_PORT:=8080}"

pnpm install
# The web app needs its built frontend artifacts (apps/cli's README: "the
# production Web runner needs already-built packages and frontend
# artifacts"); without this the page served on first boot is broken/blank.
pnpm run build

pnpm dsh --profile web --host 127.0.0.1 --port "$DSH_WEB_INTERNAL_PORT" --no-open &
dsh_pid=$!

socat "TCP-LISTEN:${DSH_WEB_INTERNAL_PROXY_PORT},fork,reuseaddr" "TCP:127.0.0.1:${DSH_WEB_INTERNAL_PORT}" &
socat_pid=$!

trap 'kill "$dsh_pid" "$socat_pid" 2>/dev/null' TERM INT

wait -n "$dsh_pid" "$socat_pid"
exit_code=$?
kill "$dsh_pid" "$socat_pid" 2>/dev/null
exit "$exit_code"
