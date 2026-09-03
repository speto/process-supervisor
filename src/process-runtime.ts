import {mkdir, open, stat} from 'node:fs/promises';
import {spawn, type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {buildChildEnvironment} from './environment.js';
import {positiveInteger, terminateKnownProcessGroup, waitForInspection, waitForSpawn} from './lifecycle.js';
import {DurableOutputFollower, attachPipeOutput} from './output.js';
import {identityFromInspection, type NormalizedProcessSpec} from './process-spec.js';
import type {
  DurableProcessLogs,
  DurableProcessRecord,
  ManagedProcessOutputEvent,
  ManagedProcessOutputStream,
  ProcessPlatform,
  ProcessRecordStore,
} from './types.js';

const MAX_OUTPUT_TAIL_BYTES = 1024 * 1024;

export interface RuntimeProcess {
  readonly record: DurableProcessRecord;
  readonly child: ChildProcess | null;
  readonly followers: DurableOutputFollower[];
  expectedStop: boolean;
  monitorTimer: NodeJS.Timeout | null;
}

export interface ProcessRuntimeContext {
  stateDirectory: string;
  recordStore: ProcessRecordStore;
  platform: ProcessPlatform;
  gracefulShutdownMs: number;
  forcedShutdownMs: number;
  groupPollMs: number;
  logPollMs: number;
  now: () => Date;
  onOutput: (event: ManagedProcessOutputEvent) => void;
}

export async function launchProcess(
  spec: NormalizedProcessSpec,
  context: ProcessRuntimeContext,
  onExit: (child: ChildProcess, code: number | null, signal: NodeJS.Signals | null) => void,
): Promise<RuntimeProcess> {
  let durableLogs: DurableLogFiles | null = null;
  let child: ChildProcess | null = null;
  let recordSaved = false;

  try {
    durableLogs = spec.ioMode === 'durable-log'
      ? await prepareDurableLogFiles(spec.id, context)
      : null;

    child = spawn(spec.executable, [...spec.args], {
      cwd: spec.cwd,
      detached: true,
      shell: false,
      stdio: durableLogs
        ? ['ignore', durableLogs.stdoutHandle.fd, durableLogs.stderrHandle.fd]
        : ['ignore', 'pipe', 'pipe'],
      env: buildChildEnvironment(spec.executable, spec.environment),
    });

    if (!durableLogs) attachChildOutput(spec.id, child, context.onOutput);
    const launchedChild = child;
    child.once('exit', (code, signal) => onExit(launchedChild, code, signal));

    const pid = await waitForSpawn(child);
    const inspection = await waitForInspection(context.platform, pid, 500, context.groupPollMs);
    if (!inspection) throw new Error(`Process ${spec.id} exited before its identity could be captured.`);
    if (inspection.processGroupId !== pid) {
      throw new Error(`Process ${spec.id} did not start in the expected isolated process group.`);
    }

    const record: DurableProcessRecord = {
      schemaVersion: 1,
      id: spec.id,
      pid,
      processGroupId: inspection.processGroupId,
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

    const runtime: RuntimeProcess = {
      record,
      child,
      followers: createFollowers(record, context),
      expectedStop: false,
      monitorTimer: null,
    };

    if (durableLogs) {
      child.unref();
      await Promise.all(runtime.followers.map((follower) => follower.start(false)));
    }

    return runtime;
  } catch (error) {
    if (child?.pid) {
      await terminateKnownProcessGroup(
        context.platform,
        child.pid,
        context.gracefulShutdownMs,
        context.forcedShutdownMs,
        context.groupPollMs,
      ).catch(() => undefined);
    }
    if (recordSaved) await context.recordStore.remove(spec.id).catch(() => undefined);
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

  const runtime: RuntimeProcess = {
    record,
    child: null,
    followers: createFollowers(record, context),
    expectedStop: false,
    monitorTimer: null,
  };
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
  if (runtime.monitorTimer) clearTimeout(runtime.monitorTimer);
  runtime.monitorTimer = null;
  for (const follower of runtime.followers) follower.close();
}

interface DurableLogFiles {
  logs: DurableProcessLogs;
  stdoutHandle: Awaited<ReturnType<typeof open>>;
  stderrHandle: Awaited<ReturnType<typeof open>>;
}

async function prepareDurableLogFiles(
  processId: string,
  context: ProcessRuntimeContext,
): Promise<DurableLogFiles> {
  const encodedId = Buffer.from(processId, 'utf8').toString('base64url');
  const directory = join(context.stateDirectory, 'logs', encodedId);
  await mkdir(directory, {recursive: true, mode: 0o700});
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
