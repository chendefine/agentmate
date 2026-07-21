import { existsSync, readFileSync, writeFileSync } from 'node:fs';

// =============================================================================
// AgentMate CloudCLI runtime patch — subagent transcript path migration
// =============================================================================
// Claude Code moved subagent transcripts from a sibling file
//   ~/.claude/projects/<cwd>/agent-<id>.jsonl
// to a per-session subdirectory:
//   ~/.claude/projects/<cwd>/<session-id>/subagents/agent-<id>.jsonl
//
// CloudCLI's getSessionMessages() still lists agent-*.jsonl in path.dirname()
// (the project dir), so subagentTools never gets populated and the
// SubagentContainer renders with zero child tools. This patch teaches the
// compiled provider to scan BOTH the new <session-id>/subagents/ dir and the
// legacy same-dir layout, resolving each agent file's path accordingly.
//
// Full contract: docs/how_to_patch_claudecodeui.md §4 (C1–C10).
// =============================================================================

// ---- C1: target root overridable for local testing --------------------------
const DEFAULT_CLOUDCLI_ROOT = '/usr/local/lib/node_modules/@cloudcli-ai/cloudcli';
const CLOUDCLI_ROOT = process.argv[2] || DEFAULT_CLOUDCLI_ROOT;

// ---- C2: unified fail-closed exit -------------------------------------------
const ERROR_MESSAGE = '[agentmate-patch] ERROR: subagent-path anchors not found';
function fail() {
  console.error(ERROR_MESSAGE);
  process.exit(1);
}

// ---- C6: unique marker (dist-server is NOT minified, so comments survive) ---
const PATCH_MARKER = '// AgentMate subagent-path patch';

// ---- C7: target file --------------------------------------------------------
// AgentMate installs via dist-only overlay, so dist-server/ is the runtime the
// base image (coderluii/holyclaude:1.5.0) actually executes. The companion
// server/*.ts source target is intentionally omitted: agentmate never rebuilds
// CloudCLI from server/ source, so patching only the dist file is sufficient
// (see overlay README for the equivalent .ts change if a full npm i -g rebuild
// is ever adopted).
const TARGETS = [
  {
    label: 'runtime',
    path: `${CLOUDCLI_ROOT}/dist-server/server/modules/providers/list/claude/claude-sessions.provider.js`,
  },
];

// ---- Anchors ----------------------------------------------------------------
// IMPORTANT: the text in the file is from the HolyClaude base image (CloudCLI
// 1.36.2 compiled by esbuild). esbuild preserves local identifiers, single
// quotes, and indentation here verbatim (verified by extracting the file from
// the published tgz). If a future CloudCLI bump restructures getSessionMessages,
// these count-1 assertions fail loud (C4) and this patch must be re-derived.
//
// Block A — directory listing (agentFiles: Array -> Set, scan two dirs).
const OLD_A = [
  '        const projectDir = path.dirname(jsonLPath);',
  '        const files = await fsp.readdir(projectDir);',
  "        const agentFiles = files.filter((file) => file.endsWith('.jsonl') && file.startsWith('agent-'));",
].join('\n');

const NEW_A = [
  '        const projectDir = path.dirname(jsonLPath);',
  `        ${PATCH_MARKER}: transcripts moved to <projectDir>/<session-id>/subagents/.`,
  "        const sessionFile = path.basename(jsonLPath, '.jsonl');",
  "        const subagentsDir = path.join(projectDir, sessionFile, 'subagents');",
  '        const agentFiles = new Set();',
  '        for (const _scanDir of [subagentsDir, projectDir]) {',
  '          let _names = [];',
  '          try { _names = await fsp.readdir(_scanDir); } catch {}',
  '          for (const _name of _names) {',
  "            if (_name.endsWith('.jsonl') && _name.startsWith('agent-')) agentFiles.add(_name);",
  '          }',
  '        }',
].join('\n');

// Block B — per-agent path resolution (.includes -> .has; prefer new dir, fall back to legacy).
const OLD_B = [
  '            const agentFileName = `agent-${agentId}.jsonl`;',
  '            if (!agentFiles.includes(agentFileName)) {',
  '                continue;',
  '            }',
  '            const agentFilePath = path.join(projectDir, agentFileName);',
  '            const tools = await parseAgentTools(agentFilePath);',
].join('\n');

const NEW_B = [
  '            const agentFileName = `agent-${agentId}.jsonl`;',
  '            if (!agentFiles.has(agentFileName)) {',
  '                continue;',
  '            }',
  '            const _subagentPath = path.join(subagentsDir, agentFileName);',
  '            const _legacyPath = path.join(projectDir, agentFileName);',
  '            let agentFilePath;',
  '            try { await fsp.access(_subagentPath); agentFilePath = _subagentPath; }',
  '            catch { agentFilePath = _legacyPath; }',
  '            const tools = await parseAgentTools(agentFilePath);',
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

  // C3: idempotent — already patched (marker + both new blocks present) -> return.
  if (
    source.includes(PATCH_MARKER)
    && source.includes(NEW_A)
    && source.includes(NEW_B)
  ) {
    console.log(`[agentmate-patch] subagent-path already patched (${target.label})`);
    return;
  }

  // C4: each old block must occur exactly once; new blocks must not be partly there.
  if (
    countOccurrences(source, OLD_A) !== 1
    || countOccurrences(source, OLD_B) !== 1
    || source.includes(NEW_A)
    || source.includes(NEW_B)
  ) {
    fail();
  }

  source = source.replace(OLD_A, NEW_A).replace(OLD_B, NEW_B);

  // C5: post-assert — marker present exactly once, old blocks gone, new blocks present.
  if (
    countOccurrences(source, PATCH_MARKER) !== 1
    || source.includes(OLD_A)
    || source.includes(OLD_B)
    || !source.includes(NEW_A)
    || !source.includes(NEW_B)
  ) {
    fail();
  }

  try {
    writeFileSync(target.path, source);
  } catch {
    fail();
  }
  console.log(`[agentmate-patch] subagent-path patched (${target.label})`);
}

for (const target of TARGETS) {
  patchTarget(target);
}
