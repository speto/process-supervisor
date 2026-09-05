import {open, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProcessSupervisorError} from './errors.js';
import {ensurePrivateDirectory} from './private-directory.js';
import type {
  DurableProcessLogs,
  DurableProcessRecord,
  JsonValue,
  ProcessRecordEntry,
  ProcessRecordStore,
  ProcessScope,
} from './types.js';

const RECORDS_DIRECTORY = 'records';
const MAX_PROCESS_ID_BYTES = 128;
const MAX_LAUNCH_ID_BYTES = 200;
const LAUNCH_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export class FileProcessRecordStore implements ProcessRecordStore {
  readonly recordsDirectory: string;

  constructor(readonly stateDirectory: string) {
    this.recordsDirectory = join(stateDirectory, RECORDS_DIRECTORY);
  }

  async get(processId: string): Promise<ProcessRecordEntry | null> {
    await this.ensureDirectories();
    const filePath = this.pathFor(processId);
    try {
      const content = await readFile(filePath, 'utf8');
      return {kind: 'valid', record: parseDurableProcessRecord(JSON.parse(content) as unknown)};
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      return {kind: 'invalid', filePath, error: messageOf(error)};
    }
  }

  async list(): Promise<readonly ProcessRecordEntry[]> {
    try {
      await this.ensureDirectories();
      const names = (await readdir(this.recordsDirectory)).filter((name) => name.endsWith('.json')).sort();
      return await Promise.all(names.map(async (name): Promise<ProcessRecordEntry> => {
        const filePath = join(this.recordsDirectory, name);
        try {
          const content = await readFile(filePath, 'utf8');
          return {kind: 'valid', record: parseDurableProcessRecord(JSON.parse(content) as unknown)};
        } catch (error) {
          return {kind: 'invalid', filePath, error: messageOf(error)};
        }
      }));
    } catch (error) {
      if (error instanceof ProcessSupervisorError) throw error;
      throw new ProcessSupervisorError(
        'STATE_STORE_FAILED',
        `Failed to read process records: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  async save(record: DurableProcessRecord): Promise<void> {
    let temporary: string | null = null;
    try {
      await this.ensureDirectories();
      const validated = parseDurableProcessRecord(record);
      const target = this.pathFor(validated.id);
      temporary = `${target}.${randomUUID()}.tmp`;
      const content = `${JSON.stringify(validated, null, 2)}\n`;
      await writeFile(temporary, content, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
        flush: true,
      });
      await rename(temporary, target);
      temporary = null;
      await syncDirectory(this.recordsDirectory);
    } catch (error) {
      if (temporary) await rm(temporary, {force: true}).catch(() => undefined);
      if (error instanceof ProcessSupervisorError) throw error;
      throw new ProcessSupervisorError(
        'STATE_STORE_FAILED',
        `Failed to persist process record ${record.id}: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  async remove(processId: string): Promise<void> {
    try {
      await this.ensureDirectories();
      await rm(this.pathFor(processId), {force: true});
      await syncDirectory(this.recordsDirectory);
    } catch (error) {
      if (error instanceof ProcessSupervisorError) throw error;
      throw new ProcessSupervisorError(
        'STATE_STORE_FAILED',
        `Failed to remove process record ${processId}: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  private async ensureDirectories(): Promise<void> {
    await ensurePrivateDirectory(this.stateDirectory, 'Process supervisor state directory');
    await ensurePrivateDirectory(this.recordsDirectory, 'Process record directory');
  }

  private pathFor(processId: string): string {
    return join(this.recordsDirectory, `${Buffer.from(processId, 'utf8').toString('base64url')}.json`);
  }
}

export function parseDurableProcessRecord(value: unknown): DurableProcessRecord {
  const record = objectValue(value, 'process record');
  const schemaVersion = integer(record.schemaVersion, 'schemaVersion');
  if (schemaVersion !== 3) throw new Error(`Unsupported process record schema version: ${schemaVersion}.`);

  const ioMode = stringValue(record.ioMode, 'ioMode');
  if (ioMode !== 'line' && ioMode !== 'pipe' && ioMode !== 'durable-log') {
    throw new Error(`Invalid process record ioMode: ${ioMode}.`);
  }

  const recoveryPolicy = stringValue(record.recoveryPolicy, 'recoveryPolicy');
  if (recoveryPolicy !== 'terminate' && recoveryPolicy !== 'adopt') throw new Error(`Invalid process record recoveryPolicy: ${recoveryPolicy}.`);

  const shutdownPolicy = stringValue(record.shutdownPolicy, 'shutdownPolicy');
  if (shutdownPolicy !== 'terminate' && shutdownPolicy !== 'preserve') throw new Error(`Invalid process record shutdownPolicy: ${shutdownPolicy}.`);

  const identityValue = objectValue(record.identity, 'identity');
  const metadata = jsonObject(record.metadata ?? {}, 'metadata');
  const logs = record.logs === undefined ? undefined : parseLogs(record.logs);

  if (recoveryPolicy === 'adopt' && ioMode !== 'durable-log') {
    throw new Error('Only durable-log processes may use adopt recovery.');
  }
  if (shutdownPolicy === 'preserve' && ioMode !== 'durable-log') {
    throw new Error('Only durable-log processes may use preserve shutdown.');
  }
  if (ioMode === 'durable-log' && logs === undefined) {
    throw new Error('durable-log process record is missing its log launch identifier.');
  }

  const commandFingerprint = identityValue.commandFingerprint === undefined
    ? undefined
    : sha256Fingerprint(identityValue.commandFingerprint, 'identity.commandFingerprint');

  return {
    schemaVersion: 3,
    id: processId(record.id, 'id'),
    pid: positiveInteger(record.pid, 'pid'),
    scope: parseScope(record.scope),
    executable: nonEmptyString(record.executable, 'executable'),
    cwd: nonEmptyString(record.cwd, 'cwd'),
    ioMode,
    recoveryPolicy,
    shutdownPolicy,
    identity: {
      startedAt: nullableNonEmptyString(identityValue.startedAt, 'identity.startedAt'),
      stableId: nullableNonEmptyString(identityValue.stableId, 'identity.stableId'),
      ...(commandFingerprint === undefined ? {} : {commandFingerprint}),
    },
    ...(logs === undefined ? {} : {logs}),
    createdAt: nonEmptyString(record.createdAt, 'createdAt'),
    metadata,
  };
}

function parseScope(value: unknown): ProcessScope {
  const scope = objectValue(value, 'scope');
  return {
    kind: nonEmptyString(scope.kind, 'scope.kind'),
    id: nonEmptyString(scope.id, 'scope.id'),
  };
}

function parseLogs(value: unknown): DurableProcessLogs {
  const logs = objectValue(value, 'logs');
  const launchId = nonEmptyString(logs.launchId, 'logs.launchId');
  if (Buffer.byteLength(launchId, 'utf8') > MAX_LAUNCH_ID_BYTES || !LAUNCH_ID_PATTERN.test(launchId)) {
    throw new Error('logs.launchId contains unsupported characters or is too long.');
  }
  return {launchId};
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error(`${label} must be a plain object.`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string.`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = stringValue(value, label);
  if (result.length === 0) throw new Error(`${label} must not be empty.`);
  return result;
}

function nullableNonEmptyString(value: unknown, label: string): string | null {
  if (value === null) return null;
  return nonEmptyString(value, label);
}

function processId(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (Buffer.byteLength(result, 'utf8') > MAX_PROCESS_ID_BYTES) {
    throw new Error(`${label} must not exceed ${MAX_PROCESS_ID_BYTES} UTF-8 bytes.`);
  }
  return result;
}

function sha256Fingerprint(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a lowercase SHA-256 fingerprint.`);
  return result;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer.`);
  return value;
}

function positiveInteger(value: unknown, label: string): number {
  const result = integer(value, label);
  if (result <= 0) throw new Error(`${label} must be positive.`);
  return result;
}

function jsonObject(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const object = objectValue(value, label);
  assertJsonValue(object, label);
  return object as Readonly<Record<string, JsonValue>>;
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number.`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertJsonValue(item, `${label}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON objects.`);
    }
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(item, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} contains a non-JSON value.`);
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
