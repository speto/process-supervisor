import assert from 'node:assert/strict';
import {chmod, mkdtemp, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  ProcessSupervisor,
  ProcessSupervisorError,
  type ManagedProcessOutputEvent,
  type ManagedProcessSnapshot,
} from '../src/index.js';

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs = 2_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition.');
}

test('launches without a shell, captures output, and terminates the whole process group', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-group-'));
  const output: ManagedProcessOutputEvent[] = [];
  let childPid: number | undefined;
  const supervisor = new ProcessSupervisor({
    stateDirectory: join(root, 'state'),
    gracefulShutdownMs: 500,
    forcedShutdownMs: 500,
    groupPollMs: 10,
    onOutput: (event) => {
      output.push(event);
      const match = event.line.match(/^child:(\d+)$/);
      if (match?.[1]) childPid = Number(match[1]);
    },
  });

  try {
    const running = await supervisor.start({
      id: 'group-test',
      executable: process.execPath,
      args: ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('child:'+child.pid); setInterval(()=>{},1000);`],
      cwd: root,
    });
    assert.equal(running.state, 'running');
    assert.equal(typeof running.pid, 'number');
    const nested = await waitFor(() => childPid);
    assert.equal(alive(running.pid!), true);
    assert.equal(alive(nested), true);

    const stopped = await supervisor.stop('group-test');
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.pid, null);
    await waitFor(() => !alive(running.pid!) ? true : undefined);
    await waitFor(() => !alive(nested) ? true : undefined);
    assert.equal(output.some((event) => event.stream === 'stdout' && event.line.startsWith('child:')), true);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('falls back to SIGKILL when the managed process group ignores SIGTERM', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-force-'));
  let ready = false;
  const supervisor = new ProcessSupervisor({
    stateDirectory: join(root, 'state'),
    gracefulShutdownMs: 75,
    forcedShutdownMs: 500,
    groupPollMs: 10,
    onOutput: (event) => {
      if (event.line === 'ready') ready = true;
    },
  });

  try {
    const running = await supervisor.start({
      id: 'force-test',
      executable: process.execPath,
      args: ['-e', `process.on('SIGTERM',()=>{}); console.log('ready'); setInterval(()=>{},1000);`],
      cwd: root,
    });
    await waitFor(() => ready ? true : undefined);
    const stopped = await supervisor.stop('force-test');
    assert.equal(stopped.state, 'stopped');
    assert.equal(stopped.forcedTermination, true);
    assert.equal(alive(running.pid!), false);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('reports unexpected exit as crashed without automatic restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-crash-'));
  const states: ManagedProcessSnapshot[] = [];
  const supervisor = new ProcessSupervisor({
    stateDirectory: join(root, 'state'),
    gracefulShutdownMs: 100,
    forcedShutdownMs: 100,
    groupPollMs: 10,
    onState: ({snapshot}) => states.push(snapshot),
  });

  try {
    await supervisor.start({
      id: 'crash-test',
      executable: process.execPath,
      args: ['-e', `setTimeout(()=>process.exit(7),150);`],
      cwd: root,
    });
    const crashed = await waitFor(() => states.find((state) => state.state === 'crashed'));
    assert.equal(crashed.lastExitCode, 7);
    assert.equal(states.filter((state) => state.state === 'running').length, 1);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('prepends the absolute executable directory to PATH for env-based sibling interpreters', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-path-'));
  const executable = join(root, 'npm-like-tool');
  const interpreter = join(root, 'process-supervisor-test-node');
  const output: ManagedProcessOutputEvent[] = [];
  await symlink(process.execPath, interpreter);
  await writeFile(executable, '#!/usr/bin/env process-supervisor-test-node\nconsole.log("sibling-interpreter-ok");\nsetTimeout(()=>{},150);\n', 'utf8');
  await chmod(executable, 0o755);

  const supervisor = new ProcessSupervisor({
    stateDirectory: join(root, 'state'),
    onOutput: (event) => output.push(event),
  });
  try {
    await supervisor.start({id: 'path-test', executable, args: [], cwd: root});
    await waitFor(() => output.some((event) => event.line === 'sibling-interpreter-ok') ? true : undefined, 8_000);
    assert.equal(output.some((event) => event.line === 'sibling-interpreter-ok'), true);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});


test('rejects adoption for parent-owned pipe I/O', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-pipe-adopt-'));
  const supervisor = new ProcessSupervisor({stateDirectory: join(root, 'state')});
  try {
    await assert.rejects(
      supervisor.start({
        id: 'pipe-adopt',
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root,
        ioMode: 'pipe',
        recoveryPolicy: 'adopt',
      }),
      (error: unknown) => error instanceof ProcessSupervisorError && error.code === 'UNSUPPORTED_RECOVERY',
    );
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('rejects non-absolute executables before launching anything', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-invalid-'));
  const supervisor = new ProcessSupervisor({stateDirectory: join(root, 'state')});
  try {
    await assert.rejects(
      supervisor.start({id: 'invalid-test', executable: 'node', args: [], cwd: root}),
      (error: unknown) => error instanceof ProcessSupervisorError && error.code === 'INVALID_SPEC',
    );
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});
