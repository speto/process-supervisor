import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  ProcessSupervisor,
  type DurableProcessRecord,
  type ProcessInspection,
  type ProcessPlatform,
  type ProcessProbe,
  type ProcessRecordEntry,
  type ProcessRecordStore,
  type ProcessScope,
  type ProcessSpawnRequest,
  type ProcessTerminationMode,
} from '../src/index.js';

const LAUNCH_ID = 'fixture';

class MemoryRecordStore implements ProcessRecordStore {
  readonly records = new Map<string, DurableProcessRecord>();

  constructor(record: DurableProcessRecord) {
    this.records.set(record.id, record);
  }

  async get(processId: string): Promise<ProcessRecordEntry | null> {
    const record = this.records.get(processId);
    return record ? {kind: 'valid', record} : null;
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

class RecoveryPlatform implements ProcessPlatform {
  inspection: ProcessInspection | null = null;
  scopeAlive = true;
  readonly terminations: ProcessScope[] = [];

  spawn(_request: ProcessSpawnRequest): never {
    throw new Error('spawn is not used by recovery tests');
  }

  scopeForSpawnedProcess(pid: number): ProcessScope {
    return {kind: 'test-scope', id: String(pid)};
  }

  async inspect(): Promise<ProcessInspection | null> {
    return this.inspection;
  }

  async probeMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessProbe>> {
    if (!this.inspection || !pids.includes(this.inspection.pid)) return new Map();
    return new Map([[
      this.inspection.pid,
      {
        pid: this.inspection.pid,
        scope: this.inspection.scope,
        stableId: this.inspection.stableId,
      },
    ]]);
  }

  async isScopeAlive(): Promise<boolean> {
    return this.scopeAlive;
  }

  async terminateScope(scope: ProcessScope, _mode: ProcessTerminationMode): Promise<void> {
    this.terminations.push(scope);
    this.scopeAlive = false;
  }
}

function record(root: string): DurableProcessRecord {
  return {
    schemaVersion: 3,
    id: 'owned',
    pid: 123,
    scope: {kind: 'test-scope', id: '123'},
    executable: '/usr/bin/example',
    cwd: root,
    ioMode: 'durable-log',
    recoveryPolicy: 'adopt',
    shutdownPolicy: 'preserve',
    identity: {
      startedAt: '2026-09-03T10:00:00.000Z',
      stableId: 'test:123:1',
    },
    logs: {launchId: LAUNCH_ID},
    createdAt: '2026-09-03T10:00:00.000Z',
    metadata: {},
  };
}

async function fixture(): Promise<{
  root: string;
  store: MemoryRecordStore;
  platform: RecoveryPlatform;
  supervisor: ProcessSupervisor;
}> {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-scope-safety-'));
  const owned = record(root);
  const logDirectory = join(root, 'logs', Buffer.from(owned.id, 'utf8').toString('base64url'));
  await mkdir(logDirectory, {recursive: true, mode: 0o700});
  await Promise.all([
    writeFile(join(logDirectory, `${LAUNCH_ID}.stdout.log`), '', {mode: 0o600}),
    writeFile(join(logDirectory, `${LAUNCH_ID}.stderr.log`), '', {mode: 0o600}),
  ]);
  const store = new MemoryRecordStore(owned);
  const platform = new RecoveryPlatform();
  const supervisor = new ProcessSupervisor({
    stateDirectory: root,
    recordStore: store,
    ownershipLease: null,
    platform,
    monitorPollMs: 60_000,
  });
  return {root, store, platform, supervisor};
}

test('retains durable ownership when the leader PID is gone but the process scope remains alive', async () => {
  const {root, store, platform, supervisor} = await fixture();
  try {
    platform.inspection = null;
    platform.scopeAlive = true;

    const result = await supervisor.reconcile();

    assert.equal(result.unresolved, 1);
    assert.equal(result.dead, 0);
    assert.equal(store.records.has('owned'), true);
    assert.equal(platform.terminations.length, 0);
    assert.equal(supervisor.getSnapshot('owned')?.state, 'unresolved');
    assert.equal(supervisor.getSnapshot('owned')?.pid, null);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('clears durable ownership only when both the leader PID and process scope are gone', async () => {
  const {root, store, platform, supervisor} = await fixture();
  try {
    platform.inspection = null;
    platform.scopeAlive = false;

    const result = await supervisor.reconcile();

    assert.equal(result.dead, 1);
    assert.equal(result.unresolved, 0);
    assert.equal(store.records.has('owned'), false);
    assert.equal(supervisor.getSnapshot('owned')?.state, 'stopped');
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});

test('retains ownership without signalling when a reused PID conflicts with a still-live recorded scope', async () => {
  const {root, store, platform, supervisor} = await fixture();
  try {
    platform.inspection = {
      pid: 123,
      scope: {kind: 'test-scope', id: '123'},
      stableId: 'test:123:reused',
      startedAt: '2026-09-03T10:00:01.000Z',
      commandLine: '/usr/bin/unrelated',
    };
    platform.scopeAlive = true;

    const result = await supervisor.reconcile();

    assert.equal(result.stale, 1);
    assert.equal(result.unresolved, 1);
    assert.equal(store.records.has('owned'), true);
    assert.equal(platform.terminations.length, 0);
    assert.equal(supervisor.getSnapshot('owned')?.state, 'unresolved');
    assert.equal(supervisor.getSnapshot('owned')?.scope, null);
  } finally {
    await supervisor.close();
    await rm(root, {recursive: true, force: true});
  }
});
