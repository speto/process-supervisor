import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {FileProcessOwnershipLease, ProcessSupervisorError} from '../src/index.js';

const LEASE_DIRECTORY = '.process-supervisor.lock';

function deadPid(): number {
  return 2_147_483_647;
}

test('racing stale-lease recovery produces exactly one owner', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-stale-lease-'));
  const leaseDirectory = join(root, LEASE_DIRECTORY);
  await mkdir(leaseDirectory, {mode: 0o700});
  await writeFile(
    join(leaseDirectory, 'owner.json'),
    `${JSON.stringify({pid: deadPid(), token: 'stale', createdAt: new Date(0).toISOString()})}\n`,
    {mode: 0o600},
  );

  const first = new FileProcessOwnershipLease(root);
  const second = new FileProcessOwnershipLease(root);
  try {
    const results = await Promise.allSettled([first.acquire(), second.acquire()]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
    assert.ok(rejected);
    assert.equal(rejected.reason instanceof ProcessSupervisorError, true);
    assert.equal((rejected.reason as ProcessSupervisorError).code, 'STATE_DIRECTORY_LOCKED');
  } finally {
    await first.release();
    await second.release();
    await rm(root, {recursive: true, force: true});
  }
});

test('a crashed unpublished lease candidate cannot permanently lock the state directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-candidate-lease-'));
  const abandonedCandidate = join(root, `${LEASE_DIRECTORY}.candidate-crashed`);
  await mkdir(abandonedCandidate, {mode: 0o700});

  const lease = new FileProcessOwnershipLease(root);
  try {
    await lease.acquire();
    const entries = await readdir(root);
    assert.equal(entries.includes(LEASE_DIRECTORY), true);
  } finally {
    await lease.release();
    await rm(root, {recursive: true, force: true});
  }
});

test('a published corrupt lease fails closed instead of being guessed stale', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-corrupt-lease-'));
  const leaseDirectory = join(root, LEASE_DIRECTORY);
  await mkdir(leaseDirectory, {mode: 0o700});
  await writeFile(join(leaseDirectory, 'owner.json'), '{broken', {mode: 0o600});

  const lease = new FileProcessOwnershipLease(root);
  try {
    await assert.rejects(
      lease.acquire(),
      (error: unknown) => error instanceof ProcessSupervisorError && error.code === 'STATE_DIRECTORY_LOCKED',
    );
  } finally {
    await lease.release();
    await rm(root, {recursive: true, force: true});
  }
});
