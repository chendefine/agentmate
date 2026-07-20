import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// State machine mirroring verify-cloudcli-account-management-support.mjs.
// Accepts either an installed CloudCLI root (argv[2], default
// /usr/local/lib/node_modules/@cloudcli-ai/cloudcli) or a built tgz file.
//
// Markers are chosen to survive esbuild minification (JS comments do not): the
// `data-agentmate-office-preview` attribute string on the OfficePreview wrapper,
// and the office OOXML MIME literal compiled out of EXTENSION_MIME.

const DEFAULT_CLOUDCLI_ROOT = '/usr/local/lib/node_modules/@cloudcli-ai/cloudcli';
const inputPath = process.argv[2] || DEFAULT_CLOUDCLI_ROOT;
const knownUnsupportedVersions = new Set([]);

let cleanupPath = null;

function unpackIfNeeded(candidatePath) {
  if (statSync(candidatePath).isFile()) {
    const unpackRoot = mkdtempSync(path.join(tmpdir(), 'agentmate-cloudcli-office-'));
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

function hasOfficeChunk(root) {
  const assetsDir = path.join(root, 'dist/assets');
  if (!existsSync(assetsDir)) {
    return false;
  }
  return readdirSync(assetsDir).some((name) => /officepreview/i.test(name));
}

function includesAll(source, markers) {
  return markers.every((marker) => source.includes(marker));
}

const root = unpackIfNeeded(inputPath);
const packageJson = readPackageJson(root);
const clientAssets = readClientAssets(root);

const BRIDGE_MARKER = 'data-agentmate-office-preview';
const OFFICE_MIME_MARKER = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const OFFICE_DEP = '@open-file-viewer/core';

const lockfile = readOptional(path.join(root, 'npm-shrinkwrap.json')) || readOptional(path.join(root, 'package-lock.json'));

const checks = {
  bridgeMarkerInAssets: clientAssets.includes(BRIDGE_MARKER),
  officeMimeInAssets: clientAssets.includes(OFFICE_MIME_MARKER),
  officeChunk: hasOfficeChunk(root),
  officeDepLocked: lockfile.includes(OFFICE_DEP),
};

const complete = checks.bridgeMarkerInAssets && checks.officeMimeInAssets;

let state;
let ok;
if (complete && checks.bridgeMarkerInAssets) {
  // Bridge fully present (the attribute marker only exists in the AgentMate bridge).
  state = 'agentmate-bridge-complete';
  ok = true;
} else if (checks.officeMimeInAssets && !checks.bridgeMarkerInAssets && !checks.officeDepLocked) {
  // Office routing present without the AgentMate bridge or @open-file-viewer dep:
  // CloudCLI shipped native office preview → safe to remove this overlay.
  state = 'upstream-complete';
  ok = true;
} else if (!checks.bridgeMarkerInAssets && !checks.officeMimeInAssets && knownUnsupportedVersions.has(packageJson.version)) {
  state = 'unsupported-known';
  ok = false;
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
