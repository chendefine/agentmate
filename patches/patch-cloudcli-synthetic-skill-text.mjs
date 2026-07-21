import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// =============================================================================
// AgentMate CloudCLI runtime patch — hide synthetic (SKILL.md) user text
// =============================================================================
// When Claude Code triggers a Skill, the CLI reads SKILL.md and injects its
// content as a synthetic user message. The two protocols disagree on how that
// injected message is flagged:
//
//   - live stream (stream-json): the user message carries isSynthetic: true
//   - transcript on disk (history): the same content is persisted with isMeta: true
//
// normalizeMessage() gates the whole user branch on `raw.isMeta !== true`, so:
//   - history: the SKILL.md text is already skipped (isMeta) -> never returned
//   - live stream: isMeta is absent, only isSynthetic is set -> the guard passes
//     -> normalizeMessage emits {kind:'text', role:'user', content: <SKILL.md>}
//     -> the frontend (useChatMessages.ts) renders the entire SKILL.md as a user
//        chat bubble, and it never matches history.
//
// Fix: mirror the isMeta skip by also skipping isSynthetic. This makes the live
// stream consistent with history AND stops the SKILL.md content from leaking as
// a user message. Real user input, assistant text, the "Launching skill: <name>"
// tool_result, and <task-notification> messages are NOT isSynthetic (verified:
// task-notification is isMeta-absent in history, and isSynthetic mirrors isMeta),
// so the Skill tool_use + its ack stay visible and subagent-folding is untouched.
//
// Full contract: docs/how_to_patch_claudecodeui.md §4 (C1–C10). This patch is a
// direct sibling of patch-cloudcli-subagent-path.mjs — same file, different
// function (normalizeMessage vs getSessionMessages), non-overlapping anchors.
// =============================================================================

// ---- C1: target root overridable for local testing --------------------------
const DEFAULT_CLOUDCLI_ROOT = '/usr/local/lib/node_modules/@cloudcli-ai/cloudcli';
const CLOUDCLI_ROOT = process.argv[2] || DEFAULT_CLOUDCLI_ROOT;

// ---- C2: unified fail-closed exit -------------------------------------------
const ERROR_MESSAGE = '[agentmate-patch] ERROR: synthetic-skill-text anchors not found';
function fail() {
  console.error(ERROR_MESSAGE);
  process.exit(1);
}

// ---- C6: unique marker (dist-server is NOT minified, so comments survive) ---
const PATCH_MARKER = '// AgentMate synthetic-skill-text patch';

// ---- C7: target file --------------------------------------------------------
// AgentMate installs via dist-only overlay, so dist-server/ is the runtime the
// base image (coderluii/holyclaude:1.5.0) actually executes. The companion
// server/*.ts source target is intentionally omitted: agentmate never rebuilds
// CloudCLI from server/ source, so patching only the dist file is sufficient
// (see docs/patches/003_hide_synthetic_skill_text.md for the equivalent .ts
// change if a full npm i -g rebuild is ever adopted).
const TARGETS = [
  {
    label: 'runtime',
    path: `${CLOUDCLI_ROOT}/dist-server/server/modules/providers/list/claude/claude-sessions.provider.js`,
  },
];

// ---- Anchors ----------------------------------------------------------------
// IMPORTANT: the text in the file is from the HolyClaude base image (CloudCLI
// 1.36.2 compiled by esbuild). esbuild preserves local identifiers, single
// quotes, optional chaining (?.) and indentation here verbatim (verified by
// extracting the file from the base image: line 237, single isMeta occurrence).
// If a future CloudCLI bump restructures normalizeMessage's user guard, the
// count-1 assertion fails loud (C4) and this patch must be re-derived.
//
// The guard is a single line; we prepend a comment and extend the condition.
const OLD_ANCHOR =
  '        if (raw.message?.role === \'user\' && raw.message?.content && raw.isMeta !== true) {';

const NEW_ANCHOR = [
  `        ${PATCH_MARKER}: live stream marks harness-injected user text`,
  '        // (isSynthetic, e.g. SKILL.md content) which the transcript persists as isMeta.',
  '        // Mirror the isMeta skip so injected skill text no longer renders as a user',
  '        // message in the stream, keeping live and history consistent.',
  '        if (raw.message?.role === \'user\' && raw.message?.content && raw.isMeta !== true && raw.isSynthetic !== true) {',
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

  // C3: idempotent — already patched (marker + new guard present) -> return.
  if (source.includes(PATCH_MARKER) && source.includes(NEW_ANCHOR)) {
    console.log(`[agentmate-patch] synthetic-skill-text already patched (${target.label})`);
    return;
  }

  // C4: old guard must occur exactly once; new guard must not already be partly there.
  if (countOccurrences(source, OLD_ANCHOR) !== 1 || source.includes(NEW_ANCHOR)) {
    fail();
  }

  source = source.replace(OLD_ANCHOR, NEW_ANCHOR);

  // C5: post-assert — marker present exactly once, old guard gone, new guard present.
  if (
    countOccurrences(source, PATCH_MARKER) !== 1
    || source.includes(OLD_ANCHOR)
    || !source.includes(NEW_ANCHOR)
  ) {
    fail();
  }

  try {
    writeFileSync(target.path, source);
  } catch {
    fail();
  }
  console.log(`[agentmate-patch] synthetic-skill-text patched (${target.label})`);
}

for (const target of TARGETS) {
  patchTarget(target);
}
