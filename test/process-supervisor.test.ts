import assert from 'node:assert/strict';
import {chmod, mkdtemp, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {once} from 'node:events';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  FileProcessRecordStore,
  PosixProcessPlatform,
  ProcessSupervisor,
  ProcessSupervisorError,
  type DurableProcessRecord,
  type ManagedProcessOutputEvent,
  type ManagedProcessSnapshot,
  type ProcessPlatform,
  type ProcessProbe,
  type ProcessRecordEntry,
  type ProcessRecordStore,
  type ProcessScope,
  type ProcessSpawnRequest,
  type ProcessTerminationMode,
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
    assert.equal(running.scope?.kind, 'posix-process-group');
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

test('falls back to forced termination when the managed process scope ignores graceful termination', async () => {
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

test('exposes raw bidirectional stdio for pipe mode without line transformation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-pipe-'));
  const output: ManagedProcessOutputEvent[] = [];
  const supervisor = new ProcessSupervisor({
    stateDirectory: join(root, 'state'),
    onOutput: (event) => output.push(event),
  });

  try {
    await supervisor.start({
      id: 'protocol',
      executable: process.execPath,
      args: ['-e', 'process.stdin.on("data", chunk => process.stdout.write(chunk)); setInterval(()=>{},1000);'],
      cwd: root,
      ioMode: 'pipe',
    });
    const transport = supervisor.getTransport('protocol');
    const data = once(transport.stdout, 'data');
    transport.stdin.write(Buffer.from([0, 1, 10, 255]));
    const [chunk] = await data;
    assert.deepEqual(Buffer.from(chunk as Buffer), Buffer.from([0, 1, 10, 255]));
    assert.equal(output.length, 0);
    await supervisor.stop('protocol');
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('rejects adoption for parent-owned raw pipe I/O', async () => {
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

test('exclusively owns a file-backed state directory until close', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-lock-'));
  const stateDirectory = join(root, 'state');
  const first = new ProcessSupervisor({stateDirectory});
  const second = new ProcessSupervisor({stateDirectory});

  try {
    await first.start({
      id: 'first',
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: root,
    });
    await assert.rejects(
      second.start({
        id: 'second',
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root,
      }),
      (error: unknown) => error instanceof ProcessSupervisorError && error.code === 'STATE_DIRECTORY_LOCKED',
    );

    await first.stop('first');
    await first.close();

    await second.start({
      id: 'second',
      executable: process.execPath,
      args: ['-e', 'setInterval(()=>{},1000)'],
      cwd: root,
    });
    await second.stop('second');
  } finally {
    await first.close();
    await second.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('retains ownership when unexpected-exit residual cleanup fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-residual-'));
  const stateDirectory = join(root, 'state');
  const store = new FileProcessRecordStore(stateDirectory);
  const platform = new FailableTerminationPlatform();
  const supervisor = new ProcessSupervisor({
    stateDirectory,
    recordStore: store,
    platform,
    gracefulShutdownMs: 50,
    forcedShutdownMs: 50,
    groupPollMs: 10,
  });

  try {
    await supervisor.start({
      id: 'residual',
      executable: process.execPath,
      args: ['-e', `const {spawn}=require('node:child_process'); spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); setTimeout(()=>process.exit(7),100);`],
      cwd: root,
    });

    const unresolved = await waitFor(() => {
      const snapshot = supervisor.getSnapshot('residual');
      return snapshot?.state === 'unresolved' ? snapshot : undefined;
    }, 3_000);
    assert.match(unresolved.error ?? '', /ownership was retained/i);
    assert.equal((await store.get('residual'))?.kind, 'valid');

    platform.failTermination = false;
    const stopped = await supervisor.stop('residual');
    assert.equal(stopped.state, 'stopped');
    assert.equal(await store.get('residual'), null);
  } finally {
    platform.failTermination = false;
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('retains failed-launch ownership when persistence and cleanup fail in sequence', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-launch-cleanup-'));
  const stateDirectory = join(root, 'state');
  const store = new FailOnceSaveRecordStore(new FileProcessRecordStore(stateDirectory));
  const platform = new FailableTerminationPlatform();
  const supervisor = new ProcessSupervisor({
    stateDirectory,
    recordStore: store,
    platform,
    gracefulShutdownMs: 50,
    forcedShutdownMs: 50,
    groupPollMs: 10,
  });

  try {
    await assert.rejects(
      supervisor.start({
        id: 'failed-launch',
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root,
      }),
      (error: unknown) => error instanceof ProcessSupervisorError && error.code === 'PROCESS_START_FAILED',
    );
    assert.equal(supervisor.getSnapshot('failed-launch')?.state, 'unresolved');
    assert.equal((await store.get('failed-launch'))?.kind, 'valid');

    platform.failTermination = false;
    const stopped = await supervisor.stop('failed-launch');
    assert.equal(stopped.state, 'stopped');
    assert.equal(await store.get('failed-launch'), null);
  } finally {
    platform.failTermination = false;
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('bounds terminal snapshot retention and supports explicit forget', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-snapshots-'));
  const supervisor = new ProcessSupervisor({
    stateDirectory: join(root, 'state'),
    maxRetainedSnapshots: 2,
  });

  try {
    for (let index = 0; index < 4; index += 1) {
      const id = `snapshot-${index}`;
      await supervisor.start({
        id,
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root,
      });
      await supervisor.stop(id);
    }
    assert.equal(supervisor.listSnapshots().length, 2);
    const retained = supervisor.listSnapshots()[0]!;
    assert.equal(supervisor.forget(retained.id), true);
    assert.equal(supervisor.getSnapshot(retained.id), null);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('prunes old durable log launches', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-log-retention-'));
  const stateDirectory = join(root, 'state');
  const supervisor = new ProcessSupervisor({
    stateDirectory,
    maxRetainedLogLaunches: 2,
  });

  try {
    for (let index = 0; index < 4; index += 1) {
      await supervisor.start({
        id: 'logs',
        executable: process.execPath,
        args: ['-e', 'setInterval(()=>{},1000)'],
        cwd: root,
        ioMode: 'durable-log',
      });
      await supervisor.stop('logs');
    }
    const encoded = Buffer.from('logs', 'utf8').toString('base64url');
    const names = (await readdir(join(stateDirectory, 'logs', encoded))).filter((name) => name.endsWith('.log'));
    assert.equal(names.length, 4);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

class FailableTerminationPlatform implements ProcessPlatform {
  private readonly delegate = new PosixProcessPlatform();
  failTermination = true;

  spawn(request: ProcessSpawnRequest) {
    return this.delegate.spawn(request);
  }

  inspect(pid: number) {
    return this.delegate.inspect(pid);
  }

  probeMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessProbe>> {
    return this.delegate.probeMany(pids);
  }

  isScopeAlive(scope: ProcessScope): Promise<boolean> {
    return this.delegate.isScopeAlive(scope);
  }

  terminateScope(scope: ProcessScope, mode: ProcessTerminationMode): Promise<void> {
    if (this.failTermination) return Promise.reject(new Error('simulated termination failure'));
    return this.delegate.terminateScope(scope, mode);
  }
}

class FailOnceSaveRecordStore implements ProcessRecordStore {
  private failSave = true;

  constructor(private readonly delegate: ProcessRecordStore) {}

  get(processId: string): Promise<ProcessRecordEntry | null> {
    return this.delegate.get(processId);
  }

  list(): Promise<readonly ProcessRecordEntry[]> {
    return this.delegate.list();
  }

  async save(record: DurableProcessRecord): Promise<void> {
    if (this.failSave) {
      this.failSave = false;
      throw new Error('simulated persistence failure');
    }
    await this.delegate.save(record);
  }

  remove(processId: string): Promise<void> {
    return this.delegate.remove(processId);
  }
}
