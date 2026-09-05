import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {
  PosixProcessPlatform,
  ProcessSupervisor,
  type ProcessInspection,
  type ProcessPlatform,
  type ProcessProbe,
  type ProcessScope,
  type ProcessSpawnRequest,
  type ProcessTerminationMode,
} from '../src/index.js';

class IdentityCaptureFailurePlatform implements ProcessPlatform {
  private readonly delegate = new PosixProcessPlatform();
  spawnedPid: number | null = null;
  readonly terminatedScopes: ProcessScope[] = [];

  spawn(request: ProcessSpawnRequest) {
    return this.delegate.spawn(request);
  }

  scopeForSpawnedProcess(pid: number): ProcessScope {
    this.spawnedPid = pid;
    return this.delegate.scopeForSpawnedProcess(pid);
  }

  async inspect(_pid: number): Promise<ProcessInspection | null> {
    return null;
  }

  probeMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessProbe>> {
    return this.delegate.probeMany(pids);
  }

  isScopeAlive(scope: ProcessScope): Promise<boolean> {
    return this.delegate.isScopeAlive(scope);
  }

  async terminateScope(scope: ProcessScope, mode: ProcessTerminationMode): Promise<void> {
    this.terminatedScopes.push(scope);
    await this.delegate.terminateScope(scope, mode);
  }
}

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
  throw new Error('Timed out waiting for async test condition.');
}

test('failed identity capture cleans the entire provisional process scope', async () => {
  const root = await mkdtemp(join(tmpdir(), 'process-supervisor-provisional-scope-'));
  const platform = new IdentityCaptureFailurePlatform();
  let descendantPid: number | null = null;
  const supervisor = new ProcessSupervisor({
    stateDirectory: join(root, 'state'),
    platform,
    gracefulShutdownMs: 100,
    forcedShutdownMs: 500,
    groupPollMs: 10,
    onOutput: ({line}) => {
      const match = line.match(/^child:(\d+)$/);
      if (match?.[1]) descendantPid = Number(match[1]);
    },
  });

  try {
    await assert.rejects(
      supervisor.start({
        id: 'identity-failure',
        executable: process.execPath,
        args: ['-e', `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log('child:'+child.pid); setInterval(()=>{},1000);`],
        cwd: root,
      }),
    );

    assert.ok(platform.spawnedPid);
    assert.equal(platform.terminatedScopes.length > 0, true);
    await waitFor(() => !alive(platform.spawnedPid!) ? true : undefined);
    if (descendantPid !== null) await waitFor(() => !alive(descendantPid!) ? true : undefined);
  } finally {
    await supervisor.close().catch(() => undefined);
    if (platform.spawnedPid && alive(platform.spawnedPid)) {
      process.kill(-platform.spawnedPid, 'SIGKILL');
    }
    await rm(root, {recursive: true, force: true});
  }
});
