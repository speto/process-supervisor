import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {
  ProcessSupervisor,
  type DurableProcessRecord,
  type ManagedProcessOutputEvent,
  type ProcessInspection,
  type ProcessPlatform,
  type ProcessRecordEntry,
  type ProcessRecordStore,
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
  readonly signals: Array<{processGroupId: number; signal: NodeJS.Signals}> = [];
  inspection: ProcessInspection | null = null;
  inspectionError: Error | null = null;
  groupAlive = true;

  async inspect(): Promise<ProcessInspection | null> {
    if (this.inspectionError) throw this.inspectionError;
    return this.inspection;
  }

  async isProcessGroupAlive(): Promise<boolean> {
    return this.groupAlive;
  }

  async signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): Promise<void> {
    this.signals.push({processGroupId, signal});
    this.groupAlive = false;
  }
}

function record(): DurableProcessRecord {
  return {
    schemaVersion: 1,
    id: 'owned',
    pid: 123,
    processGroupId: 123,
    executable: '/usr/bin/example',
    cwd: '/tmp',
    ioMode: 'durable-log',
    recoveryPolicy: 'adopt',
    shutdownPolicy: 'preserve',
    identity: {
      startedAt: '2026-09-02T20:00:00.000Z',
      commandFingerprint: 'a'.repeat(64),
    },
    logs: {
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
    },
    createdAt: '2026-09-02T20:00:00.000Z',
    metadata: {},
  };
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

test('never signals a reused PID whose identity no longer matches', async () => {
  const store = new MemoryRecordStore([record()]);
  const platform = new FakePlatform();
  platform.inspection = {
    pid: 123,
    processGroupId: 123,
    startedAt: '2026-09-02T20:00:01.000Z',
    commandLine: '/usr/bin/unrelated',
  };
  const supervisor = new ProcessSupervisor({
    stateDirectory: '/tmp/process-supervisor-test-state',
    recordStore: store,
    platform,
  });

  const result = await supervisor.reconcile();
  assert.equal(result.stale, 1);
  assert.equal(platform.signals.length, 0);
  assert.equal(store.records.size, 0);
  await supervisor.close();
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
  assert.equal(platform.signals.length, 0);
  assert.equal(store.records.size, 1);
  await supervisor.close();
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
