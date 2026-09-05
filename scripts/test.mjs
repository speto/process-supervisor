import {chmod, copyFile, readdir, rm} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = new URL('..', import.meta.url);
const testOutput = new URL('../.test-dist', import.meta.url);
const compiledTests = new URL('../.test-dist/test', import.meta.url);
const reuseBuiltHelper = process.argv.includes('--reuse-built-helper');

await rm(testOutput, {recursive: true, force: true});
const typeScriptCompiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
await run(process.execPath, [typeScriptCompiler, '-p', 'tsconfig.test.json']);
if (process.platform === 'darwin') {
  const testHelper = fileURLToPath(new URL('../.test-dist/darwin-process-info', import.meta.url));
  if (reuseBuiltHelper) {
    const builtHelper = fileURLToPath(new URL('../dist/darwin-process-info', import.meta.url));
    await copyFile(builtHelper, testHelper);
    await chmod(testHelper, 0o755);
  } else {
    const helperBuilder = fileURLToPath(new URL('./build-darwin-helper.mjs', import.meta.url));
    await run(process.execPath, [helperBuilder, './.test-dist/darwin-process-info']);
  }
}

const testFiles = await collectTests(fileURLToPath(compiledTests));
await run(process.execPath, ['--test', ...testFiles]);
await rm(testOutput, {recursive: true, force: true});

async function collectTests(directory) {
  const entries = await readdir(directory, {withFileTypes: true});
  const files = [];
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await collectTests(absolute));
    else if (entry.name.endsWith('.test.js')) files.push(absolute);
  }
  return files.sort();
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });

    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}
