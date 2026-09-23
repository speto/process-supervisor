import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {ProcessSupervisor} from '../src/index.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor<T>(read: () => T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for finite recovery fixture.');
}

test('reconciliation terminates a finite process that survives its supervisor', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-run-recovery-'));
  const stateDirectory = join(root, 'state');
  const helperPath = fileURLToPath(new URL('./fixtures/crash-run.js', import.meta.url));
  const helper = spawn(process.execPath, [helperPath, stateDirectory, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  let childPid: number | undefined;
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk: string) => {
    output += chunk;
    const newline = output.indexOf('\n');
    if (newline < 0 || childPid) return;
    const parsed = JSON.parse(output.slice(0, newline)) as {pid?: unknown};
    if (typeof parsed.pid === 'number') childPid = parsed.pid;
  });

  try {
    const pid = await waitFor(() => childPid);
    assert.equal(alive(pid), true);

    helper.kill('SIGKILL');
    await once(helper, 'exit');
    assert.equal(alive(pid), true);

    const recovered = new ProcessSupervisor({stateDirectory, groupPollMs: 10});
    try {
      const reconciliation = await recovered.reconcile();
      assert.equal(reconciliation.terminated, 1);
      await waitFor(() => alive(pid) ? undefined : true);
      assert.equal(recovered.getSnapshot('finite-recovery')?.state, 'stopped');
    } finally {
      await recovered.close();
    }
  } finally {
    if (childPid && alive(childPid)) {
      try { process.kill(-childPid, 'SIGKILL'); } catch {}
    }
    if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
    await rm(root, {recursive: true, force: true});
  }
});
