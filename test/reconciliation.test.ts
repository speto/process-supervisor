import assert from 'node:assert/strict';
import {appendFile, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn, type ChildProcess} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {
  ProcessSupervisor,
  type DurableProcessRecord,
  type ManagedProcessOutputEvent,
  type ProcessInspection,
  type ProcessPlatform,
  type ProcessProbe,
  type ProcessRecordEntry,
  type ProcessRecordStore,
  type ProcessScope,
  type ProcessSpawnRequest,
  type ProcessTerminationMode,
} from '../src/index.js';

class MemoryRecordStore implements ProcessRecordStore {
  readonly records = new Map<string, DurableProcessRecord>();

  constructor(records: readonly DurableProcessRecord[] = []) {
    for (const record of records) this.records.set(record.id, record);
  }

  async get(processId: string): Promise<ProcessRecordEntry | null> {
    const existing = this.records.get(processId);
    return existing ? {kind: 'valid', record: existing} : null;
  }

  async list(): Promise<readonly ProcessRecordEntry[]> {
    return [...this.records.values()].map((record) => ({kind: 'valid' as const, record}));
  }

  async save(record: DurableProcessRecord): Promise<void> {
    this.records.set(record.id, record);
  }

  async remove(processId: string): Promise<void> {
    this.records.delete(processId);
  }
}

class FakePlatform implements ProcessPlatform {
  readonly terminations: Array<{scope: ProcessScope; mode: ProcessTerminationMode}> = [];
  inspection: ProcessInspection | null = null;
  inspectionError: Error | null = null;
  scopeAlive = true;
  inspectGate: Promise<void> | null = null;
  inspectStarted: (() => void) | null = null;

  spawn(_request: ProcessSpawnRequest): ChildProcess {
    throw new Error('FakePlatform.spawn is not used by these tests.');
  }

  async inspect(): Promise<ProcessInspection | null> {
    this.inspectStarted?.();
    if (this.inspectGate) await this.inspectGate;
    if (this.inspectionError) throw this.inspectionError;
    return this.inspection;
  }

  async probeMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessProbe>> {
    if (this.inspectionError) throw this.inspectionError;
    if (!this.inspection || !pids.includes(this.inspection.pid)) return new Map();
    return new Map([[this.inspection.pid, probeOf(this.inspection)]]);
  }

  async isScopeAlive(): Promise<boolean> {
    return this.scopeAlive;
  }

  async terminateScope(scope: ProcessScope, mode: ProcessTerminationMode): Promise<void> {
    this.terminations.push({scope, mode});
    this.scopeAlive = false;
  }
}

function record(overrides: Partial<DurableProcessRecord> = {}): DurableProcessRecord {
  return {
    schemaVersion: 2,
    id: 'owned',
    pid: 123,
    scope: {kind: 'test-scope', id: '123'},
    executable: '/usr/bin/example',
    cwd: '/tmp',
    ioMode: 'durable-log',
    recoveryPolicy: 'adopt',
    shutdownPolicy: 'preserve',
    identity: {
      startedAt: '2026-09-02T20:00:00.000Z',
      stableId: 'test:boot:123',
      commandFingerprint: 'a'.repeat(64),
    },
    logs: {
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
    },
    createdAt: '2026-09-02T20:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

function inspection(overrides: Partial<ProcessInspection> = {}): ProcessInspection {
  return {
    pid: 123,
    scope: {kind: 'test-scope', id: '123'},
    stableId: 'test:boot:123',
    startedAt: '2026-09-02T20:00:00.000Z',
    commandLine: '/usr/bin/example',
    ...overrides,
  };
}

function probeOf(value: ProcessInspection): ProcessProbe {
  return {pid: value.pid, scope: value.scope, stableId: value.stableId};
}

test('refuses to overwrite unreconciled durable ownership state', async () => {
  const store = new MemoryRecordStore([record()]);
  const supervisor = new ProcessSupervisor({
    stateDirectory: '/tmp/process-supervisor-test-state',
    recordStore: store,
    platform: new FakePlatform(),
  });

  await assert.rejects(
    supervisor.start({
      id: 'owned',
      executable: '/does/not/matter',
      args: [],
      cwd: '/does/not/matter',
    }),
    (error: unknown) => error instanceof Error
      && 'code' in error
      && error.code === 'PROCESS_ALREADY_MANAGED',
  );
  assert.equal(store.records.size, 1);
  await supervisor.close();
});

test('never signals a reused PID whose stable identity no longer matches', async () => {
  const store = new MemoryRecordStore([record()]);
  const platform = new FakePlatform();
  platform.inspection = inspection({stableId: 'test:boot:reused', commandLine: '/usr/bin/unrelated'});
  const supervisor = new ProcessSupervisor({
    stateDirectory: '/tmp/process-supervisor-test-state',
    recordStore: store,
    platform,
  });

  const result = await supervisor.reconcile();
  assert.equal(result.stale, 1);
  assert.equal(platform.terminations.length, 0);
  assert.equal(store.records.size, 0);
  assert.equal(supervisor.getSnapshot('owned')?.state, 'unresolved');
  await supervisor.close();
});

test('does not treat a mutable command line as process identity', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-command-identity-'));
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  await Promise.all([writeFile(stdoutPath, ''), writeFile(stderrPath, '')]);
  const store = new MemoryRecordStore([record({logs: {stdoutPath, stderrPath}})]);
  const platform = new FakePlatform();
  platform.inspection = inspection({commandLine: 'changed-title'});
  const supervisor = new ProcessSupervisor({
    stateDirectory: root,
    recordStore: store,
    platform,
    monitorPollMs: 60_000,
  });

  try {
    const result = await supervisor.reconcile();
    assert.equal(result.adopted, 1);
    assert.equal(result.stale, 0);
    assert.equal(supervisor.getSnapshot('owned')?.state, 'running');
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('keeps ownership unresolved when process inspection fails', async () => {
  const store = new MemoryRecordStore([record()]);
  const platform = new FakePlatform();
  platform.inspectionError = new Error('permission denied');
  const supervisor = new ProcessSupervisor({
    stateDirectory: '/tmp/process-supervisor-test-state',
    recordStore: store,
    platform,
  });

  const result = await supervisor.reconcile();
  assert.equal(result.unresolved, 1);
  assert.equal(platform.terminations.length, 0);
  assert.equal(store.records.size, 1);
  await supervisor.close();
});

test('serializes concurrent reconciliation and creates one durable-log follower set', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-reconcile-once-'));
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  await Promise.all([writeFile(stdoutPath, ''), writeFile(stderrPath, '')]);
  const store = new MemoryRecordStore([record({logs: {stdoutPath, stderrPath}})]);
  const platform = new FakePlatform();
  platform.inspection = inspection();
  const output: ManagedProcessOutputEvent[] = [];
  const supervisor = new ProcessSupervisor({
    stateDirectory: root,
    recordStore: store,
    platform,
    monitorPollMs: 60_000,
    logPollMs: 10,
    onOutput: (event) => output.push(event),
  });

  try {
    const results = await Promise.all([supervisor.reconcile(), supervisor.reconcile()]);
    assert.equal(results.reduce((sum, result) => sum + result.adopted, 0), 1);

    await appendFile(stdoutPath, 'only-once\n');
    await waitFor(() => output.filter((event) => event.line === 'only-once').length === 1 ? true : undefined, 2_000);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(output.filter((event) => event.line === 'only-once').length, 1);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('close waits for in-flight reconciliation and cannot finish before ownership is resolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-close-reconcile-'));
  const stdoutPath = join(root, 'stdout.log');
  const stderrPath = join(root, 'stderr.log');
  await Promise.all([writeFile(stdoutPath, ''), writeFile(stderrPath, '')]);
  const store = new MemoryRecordStore([record({
    logs: {stdoutPath, stderrPath},
    shutdownPolicy: 'terminate',
  })]);
  const platform = new FakePlatform();
  platform.inspection = inspection();
  let releaseInspection!: () => void;
  let inspectionStarted!: () => void;
  const started = new Promise<void>((resolve) => { inspectionStarted = resolve; });
  platform.inspectStarted = inspectionStarted;
  platform.inspectGate = new Promise<void>((resolve) => { releaseInspection = resolve; });
  const supervisor = new ProcessSupervisor({
    stateDirectory: root,
    recordStore: store,
    platform,
    monitorPollMs: 60_000,
    logPollMs: 10,
  });

  try {
    const reconciliation = supervisor.reconcile();
    await started;
    const closing = supervisor.close();
    releaseInspection();

    assert.equal((await reconciliation).adopted, 1);
    await closing;
    assert.equal(store.records.size, 0);
    assert.equal(supervisor.getSnapshot('owned')?.state, 'stopped');
    assert.equal(platform.terminations.length, 1);
  } finally {
    releaseInspection();
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('adopts a durable process after supervisor crash and resumes logs and control', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-adopt-'));
  const stateDirectory = join(root, 'state');
  const helperPath = fileURLToPath(new URL('./fixtures/crash-supervisor.js', import.meta.url));
  const helper = spawn(process.execPath, [helperPath, stateDirectory, root], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let childPid: number | undefined;
  let helperOutput = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk: string) => {
    helperOutput += chunk;
    const newline = helperOutput.indexOf('\n');
    if (newline < 0 || childPid) return;
    const value = JSON.parse(helperOutput.slice(0, newline)) as {pid?: unknown};
    if (typeof value.pid === 'number') childPid = value.pid;
  });

  try {
    const pid = await waitFor(() => childPid, 5_000);
    await waitFor(() => alive(pid) ? true : undefined, 2_000);

    helper.kill('SIGKILL');
    await once(helper, 'exit');
    assert.equal(alive(pid), true);

    const output: ManagedProcessOutputEvent[] = [];
    const recovered = new ProcessSupervisor({
      stateDirectory,
      groupPollMs: 10,
      monitorPollMs: 50,
      logPollMs: 25,
      onOutput: (event) => output.push(event),
    });

    try {
      const reconciliation = await recovered.reconcile();
      assert.equal(reconciliation.adopted, 1);
      const snapshot = recovered.getSnapshot('durable-server');
      assert.equal(snapshot?.state, 'running');
      assert.equal(snapshot?.origin, 'adopted');
      assert.equal(snapshot?.pid, pid);

      const history = await waitForAsync(async () => {
        const tail = await recovered.readOutputTail('durable-server', 'stdout');
        return tail.includes('ready') && tail.includes('tick:') ? tail : undefined;
      }, 5_000);
      assert.match(history, /ready/);

      await waitFor(
        () => output.some((event) => event.processId === 'durable-server' && event.line.startsWith('tick:')) ? true : undefined,
        5_000,
      );

      await recovered.stop('durable-server');
      await waitFor(() => !alive(pid) ? true : undefined, 2_000);
    } finally {
      await recovered.close();
    }
  } finally {
    if (childPid && alive(childPid)) process.kill(-childPid, 'SIGKILL');
    if (helper.exitCode === null && helper.signalCode === null) helper.kill('SIGKILL');
    await rm(root, {recursive: true, force: true});
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

async function waitFor<T>(predicate: () => T | undefined, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for test condition.');
}

async function waitForAsync<T>(predicate: () => Promise<T | undefined>, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for async test condition.');
}
