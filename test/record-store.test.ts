import assert from 'node:assert/strict';
import {chmod, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  FileProcessRecordStore,
  ProcessSupervisorError,
  parseDurableProcessRecord,
  type DurableProcessRecord,
} from '../src/index.js';

function record(id: string): DurableProcessRecord {
  return {
    schemaVersion: 3,
    id,
    pid: 123,
    scope: {kind: 'posix-process-group', id: '123'},
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
    logs: {launchId: '2026-09-02T20-00-00-000Z-test'},
    createdAt: '2026-09-02T20:00:00.000Z',
    metadata: {kind: 'dev-server'},
  };
}

test('persists and reads a process record without environment data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-store-'));
  const store = new FileProcessRecordStore(root);
  try {
    await store.save(record('server:one'));
    const entries = await store.list();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.kind, 'valid');
    if (entries[0]?.kind === 'valid') {
      assert.deepEqual(entries[0].record, record('server:one'));
      assert.equal('environment' in entries[0].record, false);
      assert.deepEqual(entries[0].record.logs, {launchId: '2026-09-02T20-00-00-000Z-test'});
    }
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('isolates a corrupt record instead of failing the whole registry', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-corrupt-'));
  const store = new FileProcessRecordStore(root);
  try {
    await store.save(record('healthy'));
    await writeFile(join(store.recordsDirectory, 'broken.json'), '{not-json', 'utf8');
    const entries = await store.list();
    assert.equal(entries.some((entry) => entry.kind === 'valid'), true);
    assert.equal(entries.some((entry) => entry.kind === 'invalid'), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('uses atomic replacement rather than leaving temporary records behind', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-atomic-'));
  const store = new FileProcessRecordStore(root);
  try {
    await store.save(record('atomic'));
    await store.save({...record('atomic'), pid: 456, scope: {kind: 'posix-process-group', id: '456'}});
    const entries = await store.list();
    assert.equal(entries.length, 1);
    if (entries[0]?.kind === 'valid') assert.equal(entries[0].record.pid, 456);
    const serialized = await readFile(join(store.recordsDirectory, 'YXRvbWlj.json'), 'utf8');
    assert.equal(serialized.includes('"pid": 456'), true);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('rejects legacy durable records that can contain arbitrary log paths', () => {
  assert.throws(
    () => parseDurableProcessRecord({
      ...record('legacy'),
      schemaVersion: 2,
      logs: {stdoutPath: '/tmp/arbitrary', stderrPath: '/tmp/arbitrary'},
    }),
    /Unsupported process record schema version: 2/,
  );
});

test('rejects a state directory accessible by group or other users', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-unsafe-state-'));
  const store = new FileProcessRecordStore(root);
  try {
    await chmod(root, 0o755);
    await assert.rejects(
      store.list(),
      (error: unknown) => error instanceof ProcessSupervisorError && error.code === 'STATE_DIRECTORY_UNSAFE',
    );
  } finally {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, {recursive: true, force: true});
  }
});
