import {mkdir, open, readdir, rm, stat} from 'node:fs/promises';
import {type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {buildChildEnvironment} from './environment.js';
import {positiveInteger, terminateKnownProcessScope, waitForInspection, waitForSpawn} from './lifecycle.js';
import {DurableOutputFollower, attachPipeOutput} from './output.js';
import {identityFromInspection, type NormalizedProcessSpec} from './process-spec.js';
import type {
  DurableProcessLogs,
  DurableProcessRecord,
  ManagedProcessOutputEvent,
  ManagedProcessOutputStream,
  ManagedProcessTransport,
  ProcessPlatform,
  ProcessRecordStore,
} from './types.js';

const MAX_OUTPUT_TAIL_BYTES = 1024 * 1024;

export interface RuntimeProcess {
  readonly record: DurableProcessRecord;
  readonly child: ChildProcess | null;
  readonly followers: DurableOutputFollower[];
  readonly transport: ManagedProcessTransport | null;
  expectedStop: boolean;
}

export interface ProcessRuntimeContext {
  stateDirectory: string;
  recordStore: ProcessRecordStore;
  platform: ProcessPlatform;
  gracefulShutdownMs: number;
  forcedShutdownMs: number;
  groupPollMs: number;
  logPollMs: number;
  maxRetainedLogLaunches: number;
  now: () => Date;
  onOutput: (event: ManagedProcessOutputEvent) => void;
}

export class ProcessLaunchFailure extends Error {
  constructor(
    readonly originalError: unknown,
    readonly cleanupError: unknown,
    readonly residualRuntime: RuntimeProcess | null,
    readonly recordPersisted: boolean,
  ) {
    super(`Launch failed and residual process cleanup also failed: ${messageOf(cleanupError)}`, {cause: originalError});
    this.name = 'ProcessLaunchFailure';
  }
}

export async function launchProcess(
  spec: NormalizedProcessSpec,
  context: ProcessRuntimeContext,
  onExit: (child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) => void,
): Promise<RuntimeProcess> {
  let durableLogs: DurableLogFiles | null = null;
  let child: ChildProcess | null = null;
  let record: DurableProcessRecord | null = null;
  let runtime: RuntimeProcess | null = null;
  let recordSaved = false;

  try {
    durableLogs = spec.ioMode === 'durable-log'
      ? await prepareDurableLogFiles(spec.id, context)
      : null;

    child = context.platform.spawn({
      executable: spec.executable,
      args: spec.args,
      cwd: spec.cwd,
      stdio: durableLogs
        ? ['ignore', durableLogs.stdoutHandle.fd, durableLogs.stderrHandle.fd]
        : spec.ioMode === 'pipe'
          ? ['pipe', 'pipe', 'pipe']
          : ['ignore', 'pipe', 'pipe'],
      env: buildChildEnvironment(spec.executable, spec.environment),
    });

    if (spec.ioMode === 'line') attachChildOutput(spec.id, child, context.onOutput);
    const launchedChild = child;
    child.once('exit', (code, signal) => onExit(launchedChild, code, signal));

    const pid = await waitForSpawn(child);
    const inspection = await waitForInspection(context.platform, pid, 500, context.groupPollMs);
    if (!inspection) throw new Error(`Process ${spec.id} exited before its identity could be captured.`);

    record = {
      schemaVersion: 2,
      id: spec.id,
      pid,
      scope: inspection.scope,
      executable: spec.executable,
      cwd: spec.cwd,
      ioMode: spec.ioMode,
      recoveryPolicy: spec.recoveryPolicy,
      shutdownPolicy: spec.shutdownPolicy,
      identity: identityFromInspection(inspection),
      ...(durableLogs ? {logs: durableLogs.logs} : {}),
      createdAt: context.now().toISOString(),
      metadata: spec.metadata,
    };

    await context.recordStore.save(record);
    recordSaved = true;

    runtime = createRuntime(record, child, context);
    if (durableLogs) {
      child.unref();
      await Promise.all(runtime.followers.map((follower) => follower.start(false)));
    }

    return runtime;
  } catch (error) {
    if (runtime) releaseRuntime(runtime);
    if (child?.pid) {
      const cleanup = await cleanupFailedLaunch(child, record, recordSaved, context);
      if (cleanup.error) {
        throw new ProcessLaunchFailure(error, cleanup.error, cleanup.runtime, cleanup.recordPersisted);
      }
      recordSaved = cleanup.recordPersisted;
    }
    if (recordSaved && record) await context.recordStore.remove(spec.id);
    throw error;
  } finally {
    await durableLogs?.stdoutHandle.close().catch(() => undefined);
    await durableLogs?.stderrHandle.close().catch(() => undefined);
  }
}

export async function adoptProcess(
  record: DurableProcessRecord,
  context: ProcessRuntimeContext,
): Promise<RuntimeProcess> {
  if (record.ioMode !== 'durable-log' || !record.logs) {
    throw new Error('Only durable-log processes can be adopted.');
  }

  const runtime = createRuntime(record, null, context);
  try {
    await Promise.all(runtime.followers.map((follower) => follower.start(true)));
    return runtime;
  } catch (error) {
    releaseRuntime(runtime);
    throw error;
  }
}

export async function readDurableOutputTail(
  runtime: RuntimeProcess,
  stream: ManagedProcessOutputStream,
  maxBytes: number,
): Promise<string> {
  const logs = runtime.record.logs;
  if (!logs) throw new Error(`Process ${runtime.record.id} has no durable output.`);

  const boundedBytes = Math.min(positiveInteger(maxBytes, 'Output tail byte limit'), MAX_OUTPUT_TAIL_BYTES);
  const filePath = stream === 'stdout' ? logs.stdoutPath : logs.stderrPath;
  const info = await stat(filePath);
  const start = Math.max(0, info.size - boundedBytes);
  const length = info.size - start;
  if (length === 0) return '';

  const handle = await open(filePath, 'r');
  try {
    const data = Buffer.allocUnsafe(length);
    const result = await handle.read(data, 0, length, start);
    return data.subarray(0, result.bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

export function releaseRuntime(runtime: RuntimeProcess): void {
  for (const follower of runtime.followers) follower.close();
}

export async function pruneDurableLogs(
  stateDirectory: string,
  processId: string,
  keepLaunches: number,
): Promise<void> {
  const directory = logDirectory(stateDirectory, processId);
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return;
    throw error;
  }

  const launches = new Map<string, string[]>();
  for (const name of names) {
    const match = name.match(/^(.*)\.(stdout|stderr)\.log$/);
    if (!match?.[1]) continue;
    const files = launches.get(match[1]) ?? [];
    files.push(name);
    launches.set(match[1], files);
  }

  const stale = [...launches.keys()].sort().slice(0, Math.max(0, launches.size - keepLaunches));
  await Promise.all(stale.flatMap((launch) => (launches.get(launch) ?? []).map((name) => rm(join(directory, name), {force: true}))));
}

interface DurableLogFiles {
  logs: DurableProcessLogs;
  stdoutHandle: Awaited<ReturnType<typeof open>>;
  stderrHandle: Awaited<ReturnType<typeof open>>;
}

interface FailedLaunchCleanupResult {
  error: unknown | null;
  runtime: RuntimeProcess | null;
  recordPersisted: boolean;
}

async function cleanupFailedLaunch(
  child: ChildProcess,
  record: DurableProcessRecord | null,
  recordSaved: boolean,
  context: ProcessRuntimeContext,
): Promise<FailedLaunchCleanupResult> {
  if (!record) {
    try {
      child.kill('SIGKILL');
      return {error: null, runtime: null, recordPersisted: false};
    } catch (error) {
      return {error, runtime: null, recordPersisted: false};
    }
  }

  try {
    await terminateKnownProcessScope(
      context.platform,
      record.scope,
      context.gracefulShutdownMs,
      context.forcedShutdownMs,
      context.groupPollMs,
    );
    return {error: null, runtime: null, recordPersisted: recordSaved};
  } catch (cleanupError) {
    let persisted = recordSaved;
    if (!persisted) {
      try {
        await context.recordStore.save(record);
        persisted = true;
      } catch {
        // In-memory ownership is still retained even if durable persistence is unavailable.
      }
    }
    return {
      error: cleanupError,
      runtime: createRuntime(record, child, context),
      recordPersisted: persisted,
    };
  }
}

async function prepareDurableLogFiles(
  processId: string,
  context: ProcessRuntimeContext,
): Promise<DurableLogFiles> {
  const directory = logDirectory(context.stateDirectory, processId);
  await mkdir(directory, {recursive: true, mode: 0o700});
  await pruneDurableLogs(context.stateDirectory, processId, Math.max(0, context.maxRetainedLogLaunches - 1));
  const launch = `${context.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const logs = {
    stdoutPath: join(directory, `${launch}.stdout.log`),
    stderrPath: join(directory, `${launch}.stderr.log`),
  };
  const stdoutHandle = await open(logs.stdoutPath, 'wx', 0o600);
  try {
    const stderrHandle = await open(logs.stderrPath, 'wx', 0o600);
    return {logs, stdoutHandle, stderrHandle};
  } catch (error) {
    await stdoutHandle.close().catch(() => undefined);
    throw error;
  }
}

function createRuntime(
  record: DurableProcessRecord,
  child: ChildProcess | null,
  context: ProcessRuntimeContext,
): RuntimeProcess {
  return {
    record,
    child,
    followers: createFollowers(record, context),
    transport: child && record.ioMode === 'pipe' ? transportOf(child) : null,
    expectedStop: false,
  };
}

function transportOf(child: ChildProcess): ManagedProcessTransport {
  if (!child.stdin || !child.stdout || !child.stderr) {
    throw new Error('Raw pipe process did not expose stdin/stdout/stderr streams.');
  }
  return {stdin: child.stdin, stdout: child.stdout, stderr: child.stderr};
}

function createFollowers(
  record: DurableProcessRecord,
  context: ProcessRuntimeContext,
): DurableOutputFollower[] {
  if (!record.logs) return [];
  return [
    new DurableOutputFollower(record.id, 'stdout', record.logs.stdoutPath, context.logPollMs, context.onOutput),
    new DurableOutputFollower(record.id, 'stderr', record.logs.stderrPath, context.logPollMs, context.onOutput),
  ];
}

function attachChildOutput(
  processId: string,
  child: ChildProcess,
  emit: (event: ManagedProcessOutputEvent) => void,
): void {
  if (child.stdout) attachPipeOutput(processId, child.stdout, 'stdout', emit);
  if (child.stderr) attachPipeOutput(processId, child.stderr, 'stderr', emit);
}

function logDirectory(stateDirectory: string, processId: string): string {
  return join(stateDirectory, 'logs', Buffer.from(processId, 'utf8').toString('base64url'));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
