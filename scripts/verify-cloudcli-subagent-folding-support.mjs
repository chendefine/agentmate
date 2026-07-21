import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// State machine mirroring verify-cloudcli-office-preview-support.mjs.
// Accepts either an installed CloudCLI root (argv[2], default
// /usr/local/lib/node_modules/@cloudcli-ai/cloudcli) or a built tgz file.
//
// The bridge marker is the `data-agentmate-subagent-folding` attribute string
// injected onto the SubagentContainer root div. It survives esbuild minification
// (JS comments do not), so it is the stable signal that the AgentMate
// Task->Agent subagent-folding patch landed in the frontend bundle.
//
// Note: unlike office-preview (which has a natural upstream OOXML MIME marker),
// upstream "recognizes the Agent tool name" has no reliably-detectable bundle
// signature, so removal is manual (see overlay README). The detector only
// fail-closes on drift/partial application.

const DEFAULT_CLOUDCLI_ROOT = '/usr/local/lib/node_modules/@cloudcli-ai/cloudcli';
const inputPath = process.argv[2] || DEFAULT_CLOUDCLI_ROOT;

let cleanupPath = null;

function unpackIfNeeded(candidatePath) {
  if (statSync(candidatePath).isFile()) {
    const unpackRoot = mkdtempSync(path.join(tmpdir(), 'agentmate-cloudcli-subagent-'));
    execFileSync('tar', ['-xzf', candidatePath, '-C', unpackRoot]);
    cleanupPath = unpackRoot;
    return path.join(unpackRoot, 'package');
  }
  return candidatePath;
}

function readOptional(filePath) {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return '';
  }
}

function readPackageJson(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return {};
  }
}

function readClientAssets(root) {
  const assetsDir = path.join(root, 'dist/assets');
  if (!existsSync(assetsDir)) {
    return '';
  }
  return readdirSync(assetsDir)
    .filter((name) => name.endsWith('.js'))
    .map((name) => readOptional(path.join(assetsDir, name)))
    .join('\n');
}

const root = unpackIfNeeded(inputPath);
const packageJson = readPackageJson(root);
const clientAssets = readClientAssets(root);

const BRIDGE_MARKER = 'data-agentmate-subagent-folding';

const checks = {
  bridgeMarkerInAssets: clientAssets.includes(BRIDGE_MARKER),
};

let state;
let ok;
if (checks.bridgeMarkerInAssets) {
  // Bridge fully present (the attribute marker only exists via the AgentMate patch).
  state = 'agentmate-bridge-complete';
  ok = true;
} else {
  state = 'partial-or-drifted';
  ok = false;
}

const result = {
  state,
  ok,
  package: packageJson.name || null,
  version: packageJson.version || null,
  checks,
};

console.log(JSON.stringify(result, null, 2));
if (cleanupPath) {
  rmSync(cleanupPath, { recursive: true, force: true });
}
if (!ok) {
  process.exit(1);
}
