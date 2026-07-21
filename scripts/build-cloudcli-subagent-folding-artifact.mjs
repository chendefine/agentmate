import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Mirror of scripts/build-cloudcli-office-preview-artifact.mjs, adapted for the
// AgentMate subagent-folding overlay. Differences:
//   - the patch set chains HolyClaude account-management -> office-preview ->
//     subagent-folding, so the rebuilt dist/ carries BOTH office-preview and the
//     Task->Agent subagent-folding frontend fix (the Dockerfile can overlay only
//     one dist/, so all AgentMate frontend overlays must share a single tgz)
//   - artifactFile / manifest name / detector reflect subagent-folding
//   - manifest records all three origins + a dist-overlay removal clause

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const holyclaudePatchDir = path.join(repoRoot, 'vendor/HolyClaude/vendor/patches/cloudcli-account-management');
const officePatchDir = path.join(repoRoot, 'patches/source/cloudcli-office-preview');
const subagentPatchDir = path.join(repoRoot, 'patches/source/cloudcli-subagent-folding');
const artifactDir = path.join(repoRoot, 'patches/source/artifacts');
const upstreamRepo = 'https://github.com/siteboon/claudecodeui.git';
// Clone source is overridable for offline/flaky-network builds (e.g. a local
// bare mirror via CLOUDCLI_UPSTREAM_REPO=file:///repo/.ccui-upstream.git). The
// manifest always records the canonical upstreamRepo above, never the override.
const cloneSource = process.env.CLOUDCLI_UPSTREAM_REPO || upstreamRepo;
const upstreamCommit = '615e2ca2926a68e6e3336d49b592616654a69424';
const packageVersion = '1.36.2';
const artifactFile = `cloudcli-ai-cloudcli-${packageVersion}-agentmate-subagent-folding.tgz`;
const expectedBuildImage = 'node:26.5.0-bookworm-slim@sha256:2d49d876e96237d76de412761cf05dbfe5aee325cc4406a4d41d5824c5bb8beb';
const expectedNode = 'v26.5.0';
const expectedNpm = '11.17.0';

// The web/server build (vite + tsc) does not need the Electron runtime binary,
// so skip its ~200MB postinstall download. This keeps `npm ci` fast and avoids
// intermittent stalls on the Electron CDN inside the build container. The
// produced tgz is unaffected (Electron's binary is never shipped in dist/).
process.env.ELECTRON_SKIP_BINARY_DOWNLOAD = '1';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}

const sourceArg = args.get('--source');
const keepWorkdir = args.get('--keep-workdir') === 'true';

function run(command, argsList, options = {}) {
  execFileSync(command, argsList, { stdio: 'inherit', ...options });
}

function runCapture(command, argsList, options = {}) {
  return execFileSync(command, argsList, { encoding: 'utf8', ...options }).trim();
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function sha256Text(value) {
  return createHash('sha256').update(value).digest('hex');
}

function collectFiles(root, prefix = '') {
  const entries = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name).replaceAll(path.sep, '/');
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      entries.push(...collectFiles(fullPath, relativePath));
    } else {
      entries.push(relativePath);
    }
  }
  return entries;
}

function hashFiles(root, files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) {
    const fullPath = path.join(root, file);
    const entry = lstatSync(fullPath);
    hash.update(file);
    hash.update('\0');
    if (entry.isSymbolicLink()) {
      hash.update(`symlink:${readlinkSync(fullPath)}`);
    } else if (entry.isDirectory()) {
      hash.update(`gitlink:${runCapture('git', ['ls-files', '--stage', '--', file], { cwd: root })}`);
    } else {
      hash.update(readFileSync(fullPath));
    }
    hash.update('\0');
  }
  return hash.digest('hex');
}

function normalizeDependencyTree(node) {
  const dependencies = {};
  for (const name of Object.keys(node.dependencies ?? {}).sort()) {
    const dependency = node.dependencies[name];
    dependencies[name] = {
      version: dependency.version,
      dependencies: normalizeDependencyTree(dependency).dependencies,
    };
  }
  return { dependencies };
}

// Combined, ordered patch set: HolyClaude account-management -> office-preview ->
// subagent-folding. Chaining office-preview here means this single tgz's dist/
// carries every AgentMate frontend overlay (the Dockerfile overlays only one dist/).
// Each entry is { origin, dir, file, abs }.
function collectPatches() {
  const patches = [];
  for (const [origin, dir] of [
    ['holyclaude', holyclaudePatchDir],
    ['agentmate-office-preview', officePatchDir],
    ['agentmate-subagent-folding', subagentPatchDir],
  ]) {
    for (const file of readdirSync(dir).filter((name) => name.endsWith('.patch')).sort()) {
      patches.push({ origin, dir, file, abs: path.join(dir, file) });
    }
  }
  return patches;
}

async function prepareSource(workdir) {
  if (sourceArg) {
    await cp(path.resolve(sourceArg), workdir, {
      recursive: true,
      filter: (sourcePath) => !sourcePath.includes(`${path.sep}.git${path.sep}`) && !sourcePath.endsWith(`${path.sep}.git`),
    });
    return;
  }
  run('git', ['clone', '--no-checkout', cloneSource, workdir]);
  run('git', ['checkout', upstreamCommit], { cwd: workdir });
}

const workdir = await mkdtemp(path.join(tmpdir(), 'agentmate-cloudcli-subagent-'));
try {
  const buildImage = process.env.HOLYCLAUDE_CLOUDCLI_BUILD_IMAGE;
  const actualNode = runCapture('node', ['--version']);
  const actualNpm = runCapture('npm', ['--version']);
  if (buildImage !== expectedBuildImage || actualNode !== expectedNode || actualNpm !== expectedNpm) {
    throw new Error(
      `Run scripts/build-cloudcli-office-preview-artifact-container.mjs; expected ${expectedBuildImage}, ${expectedNode}, npm ${expectedNpm}, got ${buildImage ?? 'unknown image'}, ${actualNode}, npm ${actualNpm}`,
    );
  }

  await prepareSource(workdir);
  const actualCommit = sourceArg ? runCapture('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(sourceArg) }) : upstreamCommit;
  if (actualCommit !== upstreamCommit) {
    throw new Error(`Expected CloudCLI source commit ${upstreamCommit}, got ${actualCommit}`);
  }

  const patches = collectPatches();
  for (const patch of patches) {
    // Patches are whitespace-normalized in-repo; the upstream commit is verified
    // above. Use zero context so upstream's trailing whitespace is not pulled in.
    run('git', ['apply', '-C0', patch.abs], { cwd: workdir });
  }

  const trackedFiles = runCapture('git', ['ls-files', '-z'], { cwd: workdir })
    .split('\0')
    .filter(Boolean);
  const sourceTreeHash = hashFiles(workdir, trackedFiles);

  run('npm', ['ci'], { cwd: workdir });
  run('npm', ['run', 'typecheck'], { cwd: workdir });
  run('npm', ['run', 'build'], { cwd: workdir });
  run('npm', ['run', 'lint'], { cwd: workdir });
  run('npm', ['shrinkwrap', '--omit=dev'], { cwd: workdir });

  const packDirs = [path.join(workdir, 'pack-a'), path.join(workdir, 'pack-b')];
  for (const packDir of packDirs) {
    await mkdir(packDir);
  }
  const packedPaths = packDirs.map((packDir) => {
    const packOutput = runCapture('npm', ['pack', '--pack-destination', packDir], { cwd: workdir });
    return path.join(packDir, packOutput.split('\n').at(-1));
  });
  if (sha256(packedPaths[0]) !== sha256(packedPaths[1])) {
    throw new Error('Two clean npm pack runs produced different CloudCLI artifacts');
  }

  const artifactPath = path.join(artifactDir, artifactFile);
  await rm(artifactPath, { force: true });
  await cp(packedPaths[0], artifactPath);

  const dependencyTreeHashes = [];
  for (const name of ['install-a', 'install-b']) {
    const prefix = path.join(workdir, name);
    const cache = path.join(workdir, `${name}-cache`);
    await mkdir(prefix);
    run('npm', ['install', '--global', '--prefix', prefix, artifactPath], {
      cwd: workdir,
      env: { ...process.env, npm_config_cache: cache },
    });
    const tree = JSON.parse(runCapture('npm', ['ls', '--global', '--all', '--json', '--prefix', prefix], {
      cwd: workdir,
      env: { ...process.env, npm_config_cache: cache },
    }));
    dependencyTreeHashes.push(sha256Text(JSON.stringify(normalizeDependencyTree(tree))));
  }
  if (dependencyTreeHashes[0] !== dependencyTreeHashes[1]) {
    throw new Error('Two clean CloudCLI installations produced different production dependency trees');
  }

  const unpackDir = path.join(workdir, 'pack-check');
  await mkdir(unpackDir);
  run('tar', ['-xzf', artifactPath, '-C', unpackDir]);
  const fileListHash = createHash('sha256')
    .update(collectFiles(path.join(unpackDir, 'package')).sort().join('\n'))
    .digest('hex');

  const manifest = {
    bridge: 'cloudcli-subagent-folding',
    state: 'agentmate-bridge-complete',
    upstream: {
      repository: upstreamRepo,
      commit: upstreamCommit,
      package: '@cloudcli-ai/cloudcli',
      version: packageVersion,
      license: 'AGPL-3.0-or-later',
    },
    build: {
      image: expectedBuildImage,
      node: actualNode,
      npm: actualNpm,
      commands: ['npm ci', 'npm run typecheck', 'npm run build', 'npm run lint', 'npm shrinkwrap --omit=dev', 'npm pack (twice)', 'npm install -g (twice)'],
      generatedAt: '2026-07-21T00:00:00Z',
      sourceDateNote: 'Timestamp is fixed in this manifest so reproducibility checks compare stable fields.',
      sourceTreeSha256: sourceTreeHash,
    },
    artifact: {
      file: artifactFile,
      sha256: sha256(artifactPath),
      size: statSync(artifactPath).size,
      packageFileListSha256: fileListHash,
      shrinkwrapSha256: sha256(path.join(workdir, 'npm-shrinkwrap.json')),
      productionDependencyTreeSha256: dependencyTreeHashes[0],
      duplicatePackSha256: sha256(packedPaths[1]),
    },
    patches: patches.map((patch) => ({
      origin: patch.origin,
      file: path.relative(repoRoot, patch.abs),
      sha256: sha256(patch.abs),
    })),
    installStrategy: {
      type: 'dist-only-overlay',
      reason: 'Only dist/ is overlaid onto the installed CloudCLI; dist-server/ is untouched so all seven HolyClaude runtime patches keep working with zero re-application. This cumulative tgz supersedes the office-preview-only tgz in the Dockerfile: its dist/ carries both office-preview and the subagent-folding frontend fix. The backend half of subagent-folding (subagents/ path migration) is applied separately as Layer B (patches/patch-cloudcli-subagent-path.mjs) since dist-server/ is not overlaid here.',
    },
    verification: {
      detector: 'scripts/verify-cloudcli-subagent-folding-support.mjs',
      expectedState: 'agentmate-bridge-complete',
      minificationSafeMarker: 'data-agentmate-subagent-folding',
    },
    upstreamRefs: [
      'Chained overlay: patches/source/cloudcli-office-preview/ (docx/xlsx/pptx preview)',
      'Chained overlay: vendor/HolyClaude/vendor/patches/cloudcli-account-management/ (local accounts)',
      'Backend half: patches/patch-cloudcli-subagent-path.mjs (Layer B, subagents/ path migration)',
    ],
    removal: 'Remove when upstream CloudCLI (a) recognizes the Agent tool name for subagent containers in the frontend AND (b) claude-sessions.provider natively reads <session-id>/subagents/ transcripts. Then delete patches/source/cloudcli-subagent-folding/, scripts/build-cloudcli-subagent-folding-*, patches/source/artifacts/cloudcli-*subagent-folding* + cloudcli-subagent-folding.manifest.json, patches/patch-cloudcli-subagent-path.mjs, and revert the Dockerfile Layer A stage back to the office-preview tgz (this cumulative tgz is the only consumer of the office-preview patch dir besides doc 001).',
  };

  writeFileSync(
    path.join(artifactDir, 'cloudcli-subagent-folding.manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );

  console.log(`[cloudcli-subagent] wrote ${artifactPath}`);
} finally {
  if (!keepWorkdir) {
    await rm(workdir, { recursive: true, force: true });
  } else {
    console.log(`[cloudcli-subagent] kept ${workdir}`);
  }
}
