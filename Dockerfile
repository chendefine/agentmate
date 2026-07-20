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

# ---- Layer A: office-preview (docx/xlsx/pptx + family) dist overlay ----------
# A pre-built CloudCLI tgz (upstream 615e2ca2 + HolyClaude account-management
# overlay + AgentMate office-preview patch, built by
# scripts/build-cloudcli-office-preview-artifact-container.mjs) is overlaid by
# ONLY its dist/ onto the base image's installed CloudCLI. dist-server/ is left
# untouched, so every HolyClaude runtime patch (which all write to dist-server/ or
# an external plugin dir — none writes to dist/) keeps working with zero
# re-application. The base-path runtime transforms dist/ at request time; the
# fail-closed greps below assert the rebuilt dist/ still carries every upstream
# marker that transform depends on.
COPY patches/source/artifacts/cloudcli-ai-cloudcli-1.36.2-agentmate-office-preview.tgz /tmp/agentmate/office.tgz
COPY patches/source/artifacts/cloudcli-office-preview.manifest.json /tmp/agentmate/office.manifest.json
COPY scripts/verify-cloudcli-office-preview-support.mjs /tmp/agentmate/verify-office.mjs

USER root
RUN set -e \
 && mkdir -p /tmp/agentmate/office-unpack \
 && tar -xzf /tmp/agentmate/office.tgz -C /tmp/agentmate/office-unpack package/dist \
 && mv "${CLOUDCLI_ROOT}/dist" "${CLOUDCLI_ROOT}/dist.pre-office-preview" \
 && cp -a /tmp/agentmate/office-unpack/package/dist "${CLOUDCLI_ROOT}/dist" \
 # base-path request-time transform depends on these upstream markers surviving:
 && grep -Fq 'href="/manifest.json"'                      "${CLOUDCLI_ROOT}/dist/index.html" \
 && grep -Fq "navigator.serviceWorker.register('/sw.js')" "${CLOUDCLI_ROOT}/dist/index.html" \
 && grep -Fq '"start_url": "/"'                           "${CLOUDCLI_ROOT}/dist/manifest.json" \
 && grep -Fq "const CACHE_NAME = 'claude-ui-v2';"         "${CLOUDCLI_ROOT}/dist/sw.js" \
 && find "${CLOUDCLI_ROOT}/dist/assets" -name '*.js' -print0 | xargs -0 grep -lF '__ROUTER_BASENAME__' | grep -q . \
 # office-preview bridge markers (minification-safe string literals):
 && find "${CLOUDCLI_ROOT}/dist/assets" -name '*.js' -print0 | xargs -0 grep -lF 'data-agentmate-office-preview' | grep -q . \
 && find "${CLOUDCLI_ROOT}/dist/assets" -name '*.js' -print0 | xargs -0 grep -lF 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' | grep -q . \
 # state-machine detector must report the AgentMate bridge complete:
 && node /tmp/agentmate/verify-office.mjs "${CLOUDCLI_ROOT}" | tee /tmp/agentmate/verify.json \
 && grep -q '"state": "agentmate-bridge-complete"' /tmp/agentmate/verify.json \
 && rm -rf /tmp/agentmate \
 && echo "[agentmate] office-preview dist overlay applied"

# ---- Stage AgentMate's Layer B patch scripts into the image (ephemeral) ------
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
