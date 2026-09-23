import {constants as fsConstants} from 'node:fs';
import {open, readdir, rm} from 'node:fs/promises';
import {type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {buildChildEnvironment} from './environment.js';
import {positiveInteger, terminateKnownProcessScope, waitForInspection, waitForSpawn} from './lifecycle.js';
import {DurableOutputFollower, attachPipeOutput} from './output.js';
import {ensurePrivateDirectory} from './private-directory.js';
import {identityFromInspection, type NormalizedProcessSpec} from './process-spec.js';
import type {
  DurableProcessLogs,
  DurableProcessRecord,
  ManagedProcessOutputEvent,
  ManagedProcessOutputStream,
  ManagedProcessTransport,
  ProcessPlatform,
  ProcessRecordStore,
  ProcessScope,
} from './types.js';

const MAX_OUTPUT_TAIL_BYTES = 1024 * 1024;

interface DurableLogPaths {
  stdoutPath: string;
  stderrPath: string;
}

export interface RuntimeProcess {
  readonly record: DurableProcessRecord;
  readonly child: ChildProcess | null;
  readonly followers: DurableOutputFollower[];
  readonly transport: ManagedProcessTransport | null;
  readonly logPaths: DurableLogPaths | null;
  expectedStop: boolean;
}

export type ProcessLaunchResult =
  | {kind: 'running'; runtime: RuntimeProcess}
  | {kind: 'exited'; record: DurableProcessRecord; code: number | null; signal: NodeJS.Signals | null};

export interface ProcessLaunchCallbacks {
  onExit(child: ChildProcess, code: number | null, signal: NodeJS.Signals | null): void;
  onSpawned?(child: ChildProcess): void;
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
  maxDurableLogBytes: number;
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
  callbacks: ProcessLaunchCallbacks,
): Promise<ProcessLaunchResult> {
  let durableLogs: DurableLogFiles | null = null;
  let child: ChildProcess | null = null;
  let launchScope: ProcessScope | null = null;
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
      ...(spec.argv0 === undefined ? {} : {argv0: spec.argv0}),
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
    child.once('exit', (code, signal) => callbacks.onExit(launchedChild, code, signal));

    const pid = await waitForSpawn(child);
    launchScope = context.platform.scopeForSpawnedProcess(pid);
    callbacks.onSpawned?.(child);

    record = {
      schemaVersion: 3,
      id: spec.id,
      pid,
      scope: launchScope,
      executable: spec.executable,
      cwd: spec.cwd,
      ioMode: spec.ioMode,
      recoveryPolicy: spec.recoveryPolicy,
      shutdownPolicy: spec.shutdownPolicy,
      identity: {startedAt: null, stableId: null},
      ...(durableLogs ? {logs: durableLogs.logs} : {}),
      createdAt: context.now().toISOString(),
      metadata: spec.metadata,
    };

    await context.recordStore.save(record);
    recordSaved = true;

    const inspection = await waitForInspection(
      context.platform,
      pid,
      500,
      context.groupPollMs,
      () => child?.exitCode !== null || child?.signalCode !== null,
    );
    if (!inspection) {
      const scopeAlive = await context.platform.isScopeAlive(launchScope);
      if (!scopeAlive) {
        const exit = await childExitStatus(child);
        await context.recordStore.remove(spec.id);
        recordSaved = false;
        return {kind: 'exited', record, code: exit.code, signal: exit.signal};
      }
      throw new Error(`Process ${spec.id} exited before its identity could be captured.`);
    }
    if (!scopeEquals(launchScope, inspection.scope)) {
      throw new Error(`Process ${spec.id} changed ownership scope before its identity could be captured.`);
    }

    record = {
      ...record,
      scope: inspection.scope,
      identity: identityFromInspection(inspection),
    };
    await context.recordStore.save(record);

    runtime = createRuntime(record, child, context);
    if (durableLogs) {
      child.unref();
      await Promise.all(runtime.followers.map((follower) => follower.start(false)));
    }

    return {kind: 'running', runtime};
  } catch (error) {
    if (runtime) releaseRuntime(runtime);
    if (child?.pid) {
      const cleanup = await cleanupFailedLaunch(child, launchScope, record, recordSaved, context);
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
  if (!runtime.logPaths) throw new Error(`Process ${runtime.record.id} has no durable output.`);

  const boundedBytes = Math.min(positiveInteger(maxBytes, 'Output tail byte limit'), MAX_OUTPUT_TAIL_BYTES);
  const filePath = stream === 'stdout' ? runtime.logPaths.stdoutPath : runtime.logPaths.stderrPath;
  const handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`Durable log path is not a regular file: ${filePath}`);
    const start = Math.max(0, info.size - boundedBytes);
    const length = info.size - start;
    if (length === 0) return '';

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
  const directory = await ensureLogDirectory(stateDirectory, processId);
  const names = await readdir(directory);

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
  launchScope: ProcessScope | null,
  record: DurableProcessRecord | null,
  recordSaved: boolean,
  context: ProcessRuntimeContext,
): Promise<FailedLaunchCleanupResult> {
  if (!record) {
    try {
      if (launchScope) {
        await terminateKnownProcessScope(
          context.platform,
          launchScope,
          context.gracefulShutdownMs,
          context.forcedShutdownMs,
          context.groupPollMs,
        );
      } else {
        child.kill('SIGKILL');
      }
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
    let retainedRecord = record;
    if (retainedRecord.identity.stableId === null) {
      try {
        const inspection = await waitForInspection(
          context.platform,
          retainedRecord.pid,
          500,
          context.groupPollMs,
          () => child.exitCode !== null || child.signalCode !== null,
        );
        if (inspection && scopeEquals(retainedRecord.scope, inspection.scope)) {
          retainedRecord = {...retainedRecord, scope: inspection.scope, identity: identityFromInspection(inspection)};
        }
      } catch {
        // Retain provisional ownership when stable identity still cannot be proven.
      }
    }

    let persisted = recordSaved;
    if (!persisted) {
      try {
        await context.recordStore.save(retainedRecord);
        persisted = true;
      } catch {
        // In-memory ownership is still retained even if durable persistence is unavailable.
      }
    }
    return {
      error: cleanupError,
      runtime: createRuntime(retainedRecord, child, context),
      recordPersisted: persisted,
    };
  }
}

async function prepareDurableLogFiles(
  processId: string,
  context: ProcessRuntimeContext,
): Promise<DurableLogFiles> {
  await ensureLogDirectory(context.stateDirectory, processId);
  await pruneDurableLogs(context.stateDirectory, processId, Math.max(0, context.maxRetainedLogLaunches - 1));
  const launchId = `${context.now().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`;
  const logs: DurableProcessLogs = {launchId};
  const paths = logPaths(context.stateDirectory, processId, launchId);
  const stdoutHandle = await open(paths.stdoutPath, 'ax', 0o600);
  try {
    const stderrHandle = await open(paths.stderrPath, 'ax', 0o600);
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
  const paths = record.logs
    ? logPaths(context.stateDirectory, record.id, record.logs.launchId)
    : null;
  return {
    record,
    child,
    followers: paths ? createFollowers(record.id, paths, context) : [],
    transport: child && record.ioMode === 'pipe' ? transportOf(child) : null,
    logPaths: paths,
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
  processId: string,
  paths: DurableLogPaths,
  context: ProcessRuntimeContext,
): DurableOutputFollower[] {
  return [
    new DurableOutputFollower(
      processId,
      'stdout',
      paths.stdoutPath,
      context.logPollMs,
      context.maxDurableLogBytes,
      context.onOutput,
    ),
    new DurableOutputFollower(
      processId,
      'stderr',
      paths.stderrPath,
      context.logPollMs,
      context.maxDurableLogBytes,
      context.onOutput,
    ),
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

async function ensureLogDirectory(stateDirectory: string, processId: string): Promise<string> {
  await ensurePrivateDirectory(stateDirectory, 'Process supervisor state directory');
  const root = join(stateDirectory, 'logs');
  await ensurePrivateDirectory(root, 'Process log root');
  const directory = logDirectory(stateDirectory, processId);
  await ensurePrivateDirectory(directory, 'Process log directory');
  return directory;
}

function logDirectory(stateDirectory: string, processId: string): string {
  return join(stateDirectory, 'logs', Buffer.from(processId, 'utf8').toString('base64url'));
}

function logPaths(stateDirectory: string, processId: string, launchId: string): DurableLogPaths {
  const directory = logDirectory(stateDirectory, processId);
  return {
    stdoutPath: join(directory, `${launchId}.stdout.log`),
    stderrPath: join(directory, `${launchId}.stderr.log`),
  };
}

function scopeEquals(left: ProcessScope, right: ProcessScope): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function childExitStatus(
  child: ChildProcess,
): Promise<{code: number | null; signal: NodeJS.Signals | null}> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve({code: child.exitCode, signal: child.signalCode});
  }
  return new Promise((resolve, reject) => {
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      resolve({code, signal});
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('exit', onExit);
      child.off('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}
