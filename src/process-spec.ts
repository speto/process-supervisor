import {constants as fsConstants} from 'node:fs';
import {access, stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {ProcessSupervisorError} from './errors.js';
import type {
  DurableProcessRecord,
  JsonValue,
  ManagedProcessSnapshot,
  ManagedProcessSpec,
  ProcessEnvironmentPolicy,
  ProcessInspection,
  ProcessIoMode,
  ProcessProbe,
  ProcessRecoveryPolicy,
  ProcessScope,
  ProcessShutdownPolicy,
} from './types.js';

const MAX_PROCESS_ID_BYTES = 128;

export interface NormalizedProcessSpec {
  id: string;
  executable: string;
  args: readonly string[];
  cwd: string;
  ioMode: ProcessIoMode;
  recoveryPolicy: ProcessRecoveryPolicy;
  shutdownPolicy: ProcessShutdownPolicy;
  environment: ProcessEnvironmentPolicy;
  metadata: Readonly<Record<string, JsonValue>>;
}

export function normalizeSpec(spec: ManagedProcessSpec): NormalizedProcessSpec {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw invalidSpec('Managed process specification is required.');
  }
  if (
    typeof spec.id !== 'string'
    || spec.id.length === 0
    || spec.id.includes('\0')
    || Buffer.byteLength(spec.id, 'utf8') > MAX_PROCESS_ID_BYTES
  ) {
    throw invalidSpec(`Managed process id must be 1-${MAX_PROCESS_ID_BYTES} UTF-8 bytes and contain no NUL characters.`);
  }
  if (typeof spec.executable !== 'string' || spec.executable.length === 0 || spec.executable.includes('\0')) {
    throw invalidSpec('Managed process executable must be a non-empty string without NUL characters.');
  }
  if (typeof spec.cwd !== 'string' || spec.cwd.length === 0 || spec.cwd.includes('\0')) {
    throw invalidSpec('Managed process working directory must be a non-empty string without NUL characters.');
  }
  if (
    !Array.isArray(spec.args)
    || spec.args.some((value) => typeof value !== 'string' || value.includes('\0'))
  ) {
    throw invalidSpec('Managed process arguments must be an array of strings without NUL characters.');
  }

  const ioMode = spec.ioMode ?? 'line';
  const recoveryPolicy = spec.recoveryPolicy ?? 'terminate';
  const shutdownPolicy = spec.shutdownPolicy ?? 'terminate';
  if (ioMode !== 'line' && ioMode !== 'pipe' && ioMode !== 'durable-log') {
    throw invalidSpec(`Unsupported I/O mode: ${String(ioMode)}.`);
  }
  if (recoveryPolicy !== 'terminate' && recoveryPolicy !== 'adopt') {
    throw invalidSpec(`Unsupported recovery policy: ${String(recoveryPolicy)}.`);
  }
  if (shutdownPolicy !== 'terminate' && shutdownPolicy !== 'preserve') {
    throw invalidSpec(`Unsupported shutdown policy: ${String(shutdownPolicy)}.`);
  }
  if (recoveryPolicy === 'adopt' && ioMode !== 'durable-log') {
    throw new ProcessSupervisorError('UNSUPPORTED_RECOVERY', 'Adopt recovery requires durable-log I/O.');
  }
  if (shutdownPolicy === 'preserve' && ioMode !== 'durable-log') {
    throw new ProcessSupervisorError('UNSUPPORTED_RECOVERY', 'Preserve shutdown requires durable-log I/O.');
  }

  return {
    id: spec.id,
    executable: spec.executable,
    args: [...spec.args],
    cwd: spec.cwd,
    ioMode,
    recoveryPolicy,
    shutdownPolicy,
    environment: normalizeEnvironment(spec.environment),
    metadata: cloneMetadata(spec.metadata ?? {}),
  };
}

export async function validateSpec(spec: NormalizedProcessSpec): Promise<void> {
  if (!isAbsolute(spec.executable)) {
    throw invalidSpec('Managed process executable must be an absolute path.');
  }
  if (!isAbsolute(spec.cwd)) {
    throw invalidSpec('Managed process working directory must be an absolute path.');
  }
  await access(spec.executable, fsConstants.X_OK).catch((error) => {
    throw new ProcessSupervisorError(
      'INVALID_SPEC',
      `Managed process executable is unavailable or not executable: ${messageOf(error)}`,
      {cause: error},
    );
  });
  const cwd = await stat(spec.cwd).catch((error) => {
    throw new ProcessSupervisorError(
      'INVALID_SPEC',
      `Managed process working directory is unavailable: ${messageOf(error)}`,
      {cause: error},
    );
  });
  if (!cwd.isDirectory()) {
    throw invalidSpec('Managed process working directory must be a directory.');
  }
}

export function startingSnapshot(spec: NormalizedProcessSpec): ManagedProcessSnapshot {
  return {
    id: spec.id,
    state: 'starting',
    origin: null,
    pid: null,
    scope: null,
    startedAt: null,
    lastExitCode: null,
    lastSignal: null,
    error: null,
    forcedTermination: false,
    ioMode: spec.ioMode,
    recoveryPolicy: spec.recoveryPolicy,
    shutdownPolicy: spec.shutdownPolicy,
    metadata: cloneMetadata(spec.metadata),
  };
}

export function snapshotFromRecord(
  record: DurableProcessRecord,
  state: ManagedProcessSnapshot['state'],
  origin: ManagedProcessSnapshot['origin'],
  error: string | null,
): ManagedProcessSnapshot {
  const active = state === 'running' || state === 'stopping' || state === 'unresolved';
  return {
    id: record.id,
    state,
    origin,
    pid: active ? record.pid : null,
    scope: active ? cloneScope(record.scope) : null,
    startedAt: active ? record.identity.startedAt : null,
    lastExitCode: null,
    lastSignal: null,
    error,
    forcedTermination: false,
    ioMode: record.ioMode,
    recoveryPolicy: record.recoveryPolicy,
    shutdownPolicy: record.shutdownPolicy,
    metadata: cloneMetadata(record.metadata),
  };
}

export function emptySnapshot(processId: string): ManagedProcessSnapshot {
  return {
    id: processId,
    state: 'stopped',
    origin: null,
    pid: null,
    scope: null,
    startedAt: null,
    lastExitCode: null,
    lastSignal: null,
    error: null,
    forcedTermination: false,
    ioMode: null,
    recoveryPolicy: null,
    shutdownPolicy: null,
    metadata: {},
  };
}

export function identityFromInspection(inspection: ProcessInspection): DurableProcessRecord['identity'] {
  return {
    startedAt: inspection.startedAt,
    stableId: inspection.stableId,
    commandFingerprint: commandFingerprint(inspection.commandLine),
  };
}

export function identityMatches(record: DurableProcessRecord, probe: ProcessProbe): boolean {
  return record.pid === probe.pid
    && scopeEquals(record.scope, probe.scope)
    && record.identity.stableId === probe.stableId;
}

export function cloneSnapshot(snapshot: ManagedProcessSnapshot): ManagedProcessSnapshot {
  return {
    ...snapshot,
    scope: snapshot.scope ? cloneScope(snapshot.scope) : null,
    metadata: cloneMetadata(snapshot.metadata),
  };
}

export function cloneMetadata(
  metadata: Readonly<Record<string, JsonValue>>,
): Readonly<Record<string, JsonValue>> {
  assertJsonValue(metadata, 'metadata');
  return JSON.parse(JSON.stringify(metadata)) as Record<string, JsonValue>;
}

function normalizeEnvironment(value: ProcessEnvironmentPolicy | undefined): ProcessEnvironmentPolicy {
  if (value === undefined) return {};
  if (!isPlainObject(value)) throw invalidSpec('Managed process environment policy must be a plain object.');

  const inherit = value.inherit;
  if (
    inherit !== undefined
    && (!Array.isArray(inherit) || inherit.some((name) => !isEnvironmentName(name)))
  ) {
    throw invalidSpec('Environment inherit must contain valid environment variable names.');
  }
  if (value.inheritPath !== undefined && typeof value.inheritPath !== 'boolean') {
    throw invalidSpec('Environment inheritPath must be a boolean.');
  }
  if (
    value.prependExecutableDirectoryToPath !== undefined
    && typeof value.prependExecutableDirectoryToPath !== 'boolean'
  ) {
    throw invalidSpec('Environment prependExecutableDirectoryToPath must be a boolean.');
  }

  let values: Record<string, string> | undefined;
  if (value.values !== undefined) {
    if (!isPlainObject(value.values)) throw invalidSpec('Environment values must be a plain object.');
    values = {};
    for (const [name, item] of Object.entries(value.values)) {
      if (!isEnvironmentName(name) || typeof item !== 'string' || item.includes('\0')) {
        throw invalidSpec('Environment values must map valid variable names to strings without NUL characters.');
      }
      values[name] = item;
    }
  }

  return {
    ...(inherit === undefined ? {} : {inherit: [...inherit]}),
    ...(value.inheritPath === undefined ? {} : {inheritPath: value.inheritPath}),
    ...(value.prependExecutableDirectoryToPath === undefined
      ? {}
      : {prependExecutableDirectoryToPath: value.prependExecutableDirectoryToPath}),
    ...(values === undefined ? {} : {values}),
  };
}

function cloneScope(scope: ProcessScope): ProcessScope {
  return {kind: scope.kind, id: scope.id};
}

function scopeEquals(left: ProcessScope, right: ProcessScope): boolean {
  return left.kind === right.kind && left.id === right.id;
}

function assertJsonValue(value: unknown, path: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw invalidMetadata(`${path} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw invalidMetadata(`${path} must contain only plain JSON objects.`);
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(item, `${path}.${key}`);
    }
    return;
  }
  throw invalidMetadata(`${path} contains a non-JSON value.`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isEnvironmentName(value: unknown): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('=')
    && !value.includes('\0');
}

function invalidSpec(message: string): ProcessSupervisorError {
  return new ProcessSupervisorError('INVALID_SPEC', message);
}

function invalidMetadata(message: string): ProcessSupervisorError {
  return invalidSpec(message);
}

function commandFingerprint(commandLine: string): string {
  return createHash('sha256').update(commandLine, 'utf8').digest('hex');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
