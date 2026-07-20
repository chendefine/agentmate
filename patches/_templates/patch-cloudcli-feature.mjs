// =============================================================================
// AgentMate CloudCLI runtime patch — TEMPLATE
// =============================================================================
// Copy this file to:  patches/patch-cloudcli-<your-feature>.mjs
// (the leading "patch-cloudcli-" prefix + ".mjs" suffix is required — the
// runner globs exactly that pattern, in alphabetical order.)
//
// Fill in every TODO / <placeholder>. Then test locally against a checkout:
//
//   node patches/patch-cloudcli-<feature>.mjs /opt/agentmate/vendor/claudecodeui
//   node patches/patch-cloudcli-<feature>.mjs /opt/agentmate/vendor/claudecodeui   # 2nd run must say "already patched"
//   git -C /opt/agentmate/vendor/claudecodeui diff                                # inspect
//   git -C /opt/agentmate/vendor/claudecodeui checkout -- .                       # restore
//
// Full contract: docs/how_to_patch_claudecodeui.md §4 (the ten C-rules below).
// =============================================================================

import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// ---- C1: target root overridable for local testing --------------------------
// The runner passes the CloudCLI install root as argv[2].
const DEFAULT_CLOUDCLI_ROOT = '/usr/local/lib/node_modules/@cloudcli-ai/cloudcli';
const CLOUDCLI_ROOT = process.argv[2] || DEFAULT_CLOUDCLI_ROOT;

// ---- C2: unified fail-closed exit -------------------------------------------
const ERROR_MESSAGE = '[agentmate-patch] ERROR: <feature> anchors not found';
function fail() {
  console.error(ERROR_MESSAGE);
  process.exit(1);
}

// ---- C6: unique marker ------------------------------------------------------
// Pick your own string. The Dockerfile/build can grep for this to confirm the
// patch landed, and a future verify-*.mjs can use it to detect drift.
const PATCH_MARKER = '// AgentMate <feature> patch';

// ---- C7: target files -------------------------------------------------------
// On the PUBLISHED HolyClaude image, CloudCLI runs from dist-server/ and is
// never rebuilt at runtime — so patching the dist file alone is sufficient.
// The companion server/<file>.ts source target is OPTIONAL: uncomment it only
// if you also rebuild CloudCLI from server/ source (Layer A), to keep the
// patch rebuild-safe.
const TARGETS = [
  { label: 'runtime', path: `${CLOUDCLI_ROOT}/dist-server/server/<path>/<file>.js` },
  // { label: 'source', path: `${CLOUDCLI_ROOT}/server/<path>/<file>.ts` },
];

// ---- Anchors ----------------------------------------------------------------
// IMPORTANT: because AgentMate layers on top of coderluii/holyclaude, the text
// in the file is ALREADY HolyClaude-patched. OLD_ANCHOR must match what is in
// the base image (1.5.0), not the original upstream text. Find it with:
//   grep -Rn "<snippet>" "$CLOUDCLI_ROOT/dist-server"
const OLD_ANCHOR = [
  'const launchOptions = {',
  '  headless: true,'
].join('\n');

const NEW_ANCHOR = [
  'const launchOptions = {',
  `  ${PATCH_MARKER}`,
  '  // TODO: the line(s) you are injecting',
  '  headless: true,'
].join('\n');

// ---- helpers ----------------------------------------------------------------
function countOccurrences(source, text) {
  return source.split(text).length - 1;
}

// ---- per-target patch -------------------------------------------------------
function patchTarget(target) {
  if (!existsSync(target.path)) {
    console.warn(`[agentmate-patch] skip ${target.label}: ${target.path} not present`);
    return;
  }

  let source;
  try {
    source = readFileSync(target.path, 'utf8').replace(/\r\n/g, '\n'); // C8: CRLF-normalize
  } catch {
    fail();
  }

  // C3: idempotent — already patched -> return, never re-apply.
  if (source.includes(PATCH_MARKER) && source.includes(NEW_ANCHOR)) {
    console.log(`[agentmate-patch] <feature> already patched (${target.label})`);
    return;
  }

  // C4: anchor must occur exactly once; NEW must not already be partly there.
  if (countOccurrences(source, OLD_ANCHOR) !== 1 || source.includes(NEW_ANCHOR)) {
    fail();
  }

  source = source.replace(OLD_ANCHOR, NEW_ANCHOR);

  // C5: post-assert — new marker present exactly once, old anchor gone.
  if (countOccurrences(source, PATCH_MARKER) !== 1 || !source.includes(NEW_ANCHOR)) {
    fail();
  }

  try {
    writeFileSync(target.path, source);
  } catch {
    fail();
  }
  console.log(`[agentmate-patch] <feature> patched (${target.label})`);
}

for (const target of TARGETS) {
  patchTarget(target);
}
