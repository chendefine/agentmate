# ==============================================================================
# AgentMate — custom CloudCLI layered on top of the published HolyClaude image.
#
# The base image already contains:
#   - CloudCLI (@cloudcli-ai/cloudcli) installed at
#     /usr/local/lib/node_modules/@cloudcli-ai/cloudcli
#   - HolyClaude's own Layer A (source overlay) + Layer B (runtime) patches,
#     all already applied and verified fail-closed.
#
# AgentMate adds its OWN Layer B runtime patches on top, in the exact same
# style as HolyClaude's patch-cloudcli-*.mjs. See
# docs/how_to_patch_claudecodeui.md for the full mechanism and contract.
# ==============================================================================
FROM coderluii/holyclaude:1.5.0

# CloudCLI install location in the base image (overridable at build time).
ARG CLOUDCLI_ROOT=/usr/local/lib/node_modules/@cloudcli-ai/cloudcli

# ---- Stage AgentMate's patch scripts into the image (ephemeral) -------------
# The runner globs patches/patch-cloudcli-*.mjs and applies them in order.
# templates/ and source/ are copied along for self-documentation but are NOT
# executed (they don't match the glob).
COPY scripts/apply-cloudcli-patches.sh /tmp/agentmate/apply-cloudcli-patches.sh
COPY patches/                           /tmp/agentmate/patches/

# ---- Apply every runtime patch, fail-closed, then clean up ------------------
# Patches write into the (root-owned) CloudCLI install, so run as root. Each
# patch is idempotent and self-verifying; on anchor drift its node script
# exits 1, which `set -e` in the runner propagates -> docker build fails.
USER root
RUN chmod +x /tmp/agentmate/apply-cloudcli-patches.sh \
 && CLOUDCLI_ROOT="${CLOUDCLI_ROOT}" \
    AGENTMATE_PATCH_DIR=/tmp/agentmate/patches \
    /tmp/agentmate/apply-cloudcli-patches.sh \
 && rm -rf /tmp/agentmate

# The base image's default user is root; its entrypoint drops privileges to the
# `claude` user via s6-overlay, so no USER reset is needed here.
