#!/usr/bin/env sh
# ==============================================================================
# AgentMate — apply all CloudCLI runtime patches (Layer B) on top of the
# published HolyClaude base image. Invoked from the Dockerfile build stage.
#
# Every file matching patches/patch-cloudcli-*.mjs is executed in alphabetical
# order and receives the CloudCLI install root as argv[2]. Each patch is a
# self-contained, idempotent, fail-closed script (see the contract in
# docs/how_to_patch_claudecodeui.md §4). If a patch's anchor drifts, the node
# script exits non-zero and `set -e` fails the whole docker build.
# ==============================================================================
set -eu

CLOUDCLI_ROOT="${CLOUDCLI_ROOT:-/usr/local/lib/node_modules/@cloudcli-ai/cloudcli}"
PATCH_DIR="${AGENTMATE_PATCH_DIR:-/tmp/agentmate/patches}"

if ! [ -d "${CLOUDCLI_ROOT}" ]; then
  echo "[agentmate] FATAL: CloudCLI not found at ${CLOUDCLI_ROOT}" >&2
  exit 1
fi

echo "[agentmate] CloudCLI root: ${CLOUDCLI_ROOT}"
echo "[agentmate] applying runtime patches (Layer B)..."

# POSIX sh pathname expansion is sorted. If nothing matches, the glob stays
# literal — detect that so an empty patch set is a no-op, not an error.
# shellcheck disable=SC2086
set -- "${PATCH_DIR}"/patch-cloudcli-*.mjs

case "${1-}" in
  *'patch-cloudcli-*.mjs')
    echo "[agentmate] (no patch-cloudcli-*.mjs in ${PATCH_DIR} — nothing to apply)"
    ;;
  *)
    for patch in "$@"; do
      echo "----"
      echo "[agentmate] -> $(basename "${patch}")"
      node "${patch}" "${CLOUDCLI_ROOT}"
    done
    ;;
esac

echo "----"
echo "[agentmate] CloudCLI runtime patch pass complete."
