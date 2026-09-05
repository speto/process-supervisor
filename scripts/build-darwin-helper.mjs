import {access, chmod, mkdir} from 'node:fs/promises';
import {constants as fsConstants} from 'node:fs';
import {spawn} from 'node:child_process';
import {dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const outputArgument = process.argv[2];
if (!outputArgument) throw new Error('Darwin process-info output path is required.');

const root = fileURLToPath(new URL('..', import.meta.url));
const source = fileURLToPath(new URL('../native/darwin-process-info.c', import.meta.url));
const output = fileURLToPath(new URL(outputArgument, new URL('../', import.meta.url)));
const xcrun = '/usr/bin/xcrun';

try {
  await access(xcrun, fsConstants.X_OK);
} catch (error) {
  throw new Error(
    'Building the default macOS process adapter requires Xcode Command Line Tools (/usr/bin/xcrun).',
    {cause: error},
  );
}

await mkdir(dirname(output), {recursive: true});
await run(xcrun, [
  'clang',
  '-std=c11',
  '-O2',
  '-Wall',
  '-Wextra',
  '-Werror',
  '-arch',
  'arm64',
  '-arch',
  'x86_64',
  source,
  '-o',
  output,
  '-lproc',
]);
await chmod(output, 0o755);

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${code ?? signal ?? 'unknown status'}`));
    });
  });
}
