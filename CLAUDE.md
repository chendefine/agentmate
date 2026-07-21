# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repository is

AgentMate is a **Docker image customization layer** built on top of the published
`coderluii/holyclaude:1.5.0` image. It does **not** contain application source — it
contains the machinery to patch and repackage **CloudCLI** (npm package
`@cloudcli-ai/cloudcli`, upstream repo `siteboon/claudecodeui` — the web UI that wraps
Claude Code) with AgentMate-specific fixes, then ship the result as a Docker image.

There is no `package.json`, no test suite, and no build tooling at the repo root. The
`.mjs` files under `scripts/` and `patches/` are standalone Node scripts (only `node:`
built-ins, no dependencies) run either locally or during `docker build`.

The canonical, exhaustive reference for everything below is
[docs/how_to_patch_claudecodeui.md](docs/how_to_patch_claudecodeui.md). Read it before
adding any patch. This file is a quick orientation, not a substitute.

## The core architecture: two patch layers

Every customization of CloudCLI is classified into one of two layers. Choosing the
wrong layer is the most common mistake — consult the decision tree in
[docs/how_to_patch_claudecodeui.md §7.1](docs/how_to_patch_claudecodeui.md).

**Layer A — build-time source patches.** `.patch` files applied to the upstream
claudecodeui source at a pinned commit (`615e2ca2…`, v1.36.2), rebuilt inside a pinned
container (`node:26.5.0-bookworm-slim`, npm `11.17.0`), and packed into a `.tgz` that
is **committed to this repo** under `patches/source/artifacts/`. Required when a change
must enter the **minified frontend bundle** (`dist/assets/*.js`), must pass TypeScript
typecheck, or changes `package-lock`/dependencies. Detector markers in Layer A must be
**string literals** (e.g. `data-agentmate-…` attributes) — esbuild strips JS comments,
so comment markers do not survive.

**Layer B — runtime install patches.** `patches/patch-cloudcli-*.mjs` scripts that edit
the already-installed `dist-server/*.js` at image-build time. Used for server-only
changes. `dist-server/` is **not** minified, so JS-comment markers survive here.

**The single-tgz constraint.** The Dockerfile overlays exactly **one** `dist/` onto the
base image. Therefore every AgentMate Layer A frontend overlay must be chained into one
cumulative tgz. The current cumulative artifact is
`cloudcli-ai-cloudcli-1.36.2-agentmate-subagent-folding.tgz`, whose `dist/` carries
**both** the office-preview and the subagent-folding frontend fixes. The older
office-preview-only tgz is superseded; do not re-add a second overlay. When you add a
new Layer A frontend change, extend the cumulative build script
([scripts/build-cloudcli-subagent-folding-artifact.mjs](scripts/build-cloudcli-subagent-folding-artifact.mjs))
rather than creating a parallel one.

## Common commands

```bash
# Build the image. Layer B patches run during build and fail-closed on anchor drift.
docker compose build

# Build + run (the only port is the CloudCLI web UI on $HOLYCLAUDE_HOST_PORT, default 3001).
docker compose up -d --build

# Rebuild a Layer A artifact inside the pinned node image. ALWAYS use the -container entry
# point (it pins image/node/npm via @sha256) — never run the bare .mjs directly.
node scripts/build-cloudcli-subagent-folding-artifact-container.mjs

# Production/host bring-up via systemd (depends on docker-network-tproxy.service).
sudo systemctl start docker-agentmate
```

### Test a Layer B patch locally against the vendored checkout

Run it twice — the second run **must** print `already patched` (idempotency check) —
then restore the checkout:

```bash
node patches/patch-cloudcli-<feature>.mjs /opt/agentmate/vendor/claudecodeui
node patches/patch-cloudcli-<feature>.mjs /opt/agentmate/vendor/claudecodeui
git -C /opt/agentmate/vendor/claudecodeui diff        # inspect
git -C /opt/agentmate/vendor/claudecodeui checkout -- .   # restore
```

The `vendor/` directory is a **local working reference** (upstream `claudecodeui` and
`HolyClaude` checkouts); it is excluded from the Docker context (`.dockerignore`) and
not committed. Use it to grep for real anchor text — see the note below.

## Key paths and conventions

- **CloudCLI install root** (inside the image): `/usr/local/lib/node_modules/@cloudcli-ai/cloudcli`.
  Runtime code lives in `dist-server/server/...`; the frontend bundle in `dist/`; upstream
  source in `server/...` (only relevant if rebuilding from source).
- **Layer B patches**: `patches/patch-cloudcli-*.mjs`, executed in **alphabetical order**
  by [scripts/apply-cloudcli-patches.sh](scripts/apply-cloudcli-patches.sh). Prefix with a
  number (`patch-cloudcli-10-…`) to force ordering. New patch → copy
  [patches/_templates/patch-cloudcli-feature.mjs](patches/_templates/patch-cloudcli-feature.mjs).
- **Layer A overlays**: `patches/source/<feature>/00NN-<slug>.patch` (4-digit + kebab-case,
  applied in dictionary order) + a `README.md` stating upstream commit, issue, and removal
  condition. Artifacts: `patches/source/artifacts/<feature>.tgz` + `<feature>.manifest.json`,
  committed as a pair.
- **Anchors match the base image, not upstream.** Because AgentMate layers on HolyClaude,
  `OLD_ANCHOR` in a Layer B patch must match text as it exists in `coderluii/holyclaude:1.5.0`
  (HolyClaude's own patches already applied). Find it with:
  `docker run --rm -it coderluii/holyclaude:1.5.0 grep -Rn "<snippet>" /usr/local/lib/node_modules/@cloudcli-ai/cloudcli/dist-server`
- **Runtime volumes** (gitignored — never commit; survive rebuilds): `data/cloudcli`,
  `data/claude`, `data/agents`, `workspace`, plus the read-only `data/bin/officecli`
  bind-mounted to `/usr/local/bin/officecli`.
- **Per-feature upgrade guides**: [docs/patches/](docs/patches/) (`00N_*.md`) document each
  patch's upstream version, root cause, and how to re-derive it on an upstream bump.

## Patch contract and the fail-closed philosophy

Every Layer B patch obeys a ten-rule contract (**C1–C10**): parameterizable root via
`argv[2]`, unified `fail()` → `process.exit(1)`, idempotency check, count-exactly-one
anchor assertions, post-write assertions, a unique marker, source+`dist-server` dual
targets (when applicable), CRLF normalization, helper-encapsulated replacement, and
`[patch]`/`[agentmate-patch]` log prefixes. Full rules in
[docs/how_to_patch_claudecodeui.md §4](docs/how_to_patch_claudecodeui.md).

The governing principle is **drift fails the build, never silently**. Each patch's own
post-assertions are backed by an **independent `grep -Fq <marker>` `RUN`** in the
Dockerfile, and Layer A features add a state-machine `verify-cloudcli-<feature>-support.mjs`
detector run at the end of the build. On an upstream CloudCLI bump, let the failing
assertions surface the drift, then re-derive each patch — never weaken an assertion,
silently skip a failing patch, or paper over it with `|| true`.

**Do not redo here what HolyClaude already does** (Chromium path, base-path, self-update
disable, Apprise, Codex permissions/exit-codes, Web Terminal rendering) — the base image
already has those. This repo only carries AgentMate-specific customizations.
