import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FileProcessRecordStore, type DurableProcessRecord} from '../src/index.js';

function record(id: string): DurableProcessRecord {
  return {
    schemaVersion: 2,
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
    logs: {
      stdoutPath: '/tmp/stdout.log',
      stderrPath: '/tmp/stderr.log',
    },
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
