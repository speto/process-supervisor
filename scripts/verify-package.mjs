import assert from 'node:assert/strict';
import {access, mkdtemp, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const suppliedTarball = process.argv[2];
const createdTarball = suppliedTarball === undefined;
const tarball = suppliedTarball ? resolve(root, suppliedTarball) : await pack();

try {
  await access(tarball, fsConstants.R_OK);
  const entries = await listTarball(tarball);
  verifyTarballContents(entries);
  await verifyConsumer(tarball);
  console.log(`Verified package: ${basename(tarball)}`);
} finally {
  if (createdTarball) await rm(tarball, {force: true});
}

async function pack() {
  const {stdout} = await runCapture(npmCommand(), ['pack', '--ignore-scripts', '--json'], root);
  const result = JSON.parse(stdout);
  assert.ok(Array.isArray(result) && result.length === 1, 'npm pack must produce exactly one package.');
  const filename = result[0]?.filename;
  assert.equal(typeof filename, 'string');
  return join(root, filename);
}

async function listTarball(filename) {
  const {stdout} = await runCapture('tar', ['-tzf', filename], root);
  const entries = stdout.split('\n').map((entry) => entry.trim()).filter(Boolean).sort();
  console.log('Packed tarball contents:');
  for (const entry of entries) console.log(`  ${entry}`);
  return entries;
}

function verifyTarballContents(entries) {
  assert.ok(entries.includes('package/package.json'), 'package.json is missing from the tarball.');
  assert.ok(entries.includes('package/README.md'), 'README.md is missing from the tarball.');
  assert.ok(entries.includes('package/LICENSE'), 'LICENSE is missing from the tarball.');
  assert.ok(entries.includes('package/dist/index.js'), 'dist/index.js is missing from the tarball.');
  assert.ok(entries.includes('package/dist/index.d.ts'), 'dist/index.d.ts is missing from the tarball.');

  for (const entry of entries) {
    if (entry.endsWith('/')) continue;
    const allowed = entry === 'package/package.json'
      || entry === 'package/README.md'
      || entry === 'package/LICENSE'
      || entry.startsWith('package/dist/');
    assert.equal(allowed, true, `Unexpected package file: ${entry}`);
  }
}

async function verifyConsumer(filename) {
  const consumer = await mkdtemp(join(tmpdir(), 'process-supervisor-consumer-'));
  try {
    await writeFile(join(consumer, 'package.json'), `${JSON.stringify({private: true, type: 'module'}, null, 2)}\n`, 'utf8');
    await run(npmCommand(), [
      'install',
      '--ignore-scripts',
      '--no-save',
      '--no-audit',
      '--no-fund',
      filename,
    ], consumer);

    const installedPackage = join(consumer, 'node_modules', '@speto', 'process-supervisor');
    const installedEntries = await readdir(installedPackage);
    for (const forbidden of ['src', 'test', 'scripts', 'native', '.github', 'node_modules']) {
      assert.equal(installedEntries.includes(forbidden), false, `Installed package unexpectedly contains ${forbidden}/.`);
    }

    await writeFile(
      join(consumer, 'runtime.mjs'),
      "import {ProcessSupervisor} from '@speto/process-supervisor';\nif (typeof ProcessSupervisor !== 'function') throw new Error('ProcessSupervisor export is unavailable.');\nif (typeof ProcessSupervisor.prototype.run !== 'function') throw new Error('ProcessSupervisor.run is unavailable.');\n",
      'utf8',
    );
    await run(process.execPath, ['runtime.mjs'], consumer);

    await writeFile(
      join(consumer, 'types.ts'),
      "import {ProcessSupervisor, type ProcessExecutionSpec, type ProcessPlatform, type ProcessRunResult} from '@speto/process-supervisor';\nconst constructor: typeof ProcessSupervisor = ProcessSupervisor;\nconst execution: ProcessExecutionSpec = {id: 'finite', executable: '/bin/true', args: [], cwd: '/tmp'};\ndeclare const supervisor: ProcessSupervisor;\nconst runResult: Promise<ProcessRunResult> = supervisor.run(execution);\nlet platform!: ProcessPlatform;\nvoid constructor;\nvoid execution;\nvoid runResult;\nvoid platform;\n",
      'utf8',
    );
    const typeScriptCompiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
    await run(process.execPath, [
      typeScriptCompiler,
      '--noEmit',
      '--strict',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      '--types',
      'node',
      '--typeRoots',
      join(root, 'node_modules', '@types'),
      'types.ts',
    ], consumer);

    if (process.platform === 'darwin') {
      const helper = join(installedPackage, 'dist', 'darwin-process-info');
      const helperStat = await stat(helper);
      assert.equal(helperStat.isFile(), true, 'macOS process helper is not a regular file.');
      await access(helper, fsConstants.X_OK);
      await run('/usr/bin/xcrun', ['lipo', helper, '-verify_arch', 'arm64', 'x86_64'], consumer);
    }

    const installedMetadata = JSON.parse(await readFile(join(installedPackage, 'package.json'), 'utf8'));
    assert.equal(installedMetadata.name, '@speto/process-supervisor');
    assert.equal(typeof installedMetadata.version, 'string');
    console.log('Clean consumer verification passed: install, runtime import, and TypeScript declarations.');
  } finally {
    await rm(consumer, {recursive: true, force: true});
  }
}

function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

function run(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd, stdio: 'inherit', shell: false});
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}

function runCapture(command, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: false});
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolvePromise({stdout});
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}
