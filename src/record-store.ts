import {mkdir, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProcessSupervisorError} from './errors.js';
import type {
  DurableProcessRecord,
  JsonValue,
  ProcessRecordEntry,
  ProcessRecordStore,
} from './types.js';

const RECORDS_DIRECTORY = 'records';

export class FileProcessRecordStore implements ProcessRecordStore {
  readonly recordsDirectory: string;

  constructor(readonly stateDirectory: string) {
    this.recordsDirectory = join(stateDirectory, RECORDS_DIRECTORY);
  }

  async get(processId: string): Promise<ProcessRecordEntry | null> {
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
      await mkdir(this.recordsDirectory, {recursive: true, mode: 0o700});
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
      await mkdir(this.recordsDirectory, {recursive: true, mode: 0o700});
      const target = this.pathFor(record.id);
      temporary = `${target}.${randomUUID()}.tmp`;
      const content = `${JSON.stringify(record, null, 2)}\n`;
      await writeFile(temporary, content, {encoding: 'utf8', mode: 0o600, flag: 'wx'});
      await rename(temporary, target);
      temporary = null;
    } catch (error) {
      if (temporary) await rm(temporary, {force: true}).catch(() => undefined);
      throw new ProcessSupervisorError(
        'STATE_STORE_FAILED',
        `Failed to persist process record ${record.id}: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  async remove(processId: string): Promise<void> {
    try {
      await rm(this.pathFor(processId), {force: true});
    } catch (error) {
      throw new ProcessSupervisorError(
        'STATE_STORE_FAILED',
        `Failed to remove process record ${processId}: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  private pathFor(processId: string): string {
    return join(this.recordsDirectory, `${Buffer.from(processId, 'utf8').toString('base64url')}.json`);
  }
}

export function parseDurableProcessRecord(value: unknown): DurableProcessRecord {
  const record = objectValue(value, 'process record');
  const schemaVersion = integer(record.schemaVersion, 'schemaVersion');
  if (schemaVersion !== 1) throw new Error(`Unsupported process record schema version: ${schemaVersion}.`);

  const ioMode = stringValue(record.ioMode, 'ioMode');
  if (ioMode !== 'pipe' && ioMode !== 'durable-log') throw new Error(`Invalid process record ioMode: ${ioMode}.`);

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
    throw new Error('durable-log process record is missing log paths.');
  }

  return {
    schemaVersion: 1,
    id: nonEmptyString(record.id, 'id'),
    pid: positiveInteger(record.pid, 'pid'),
    processGroupId: positiveInteger(record.processGroupId, 'processGroupId'),
    executable: nonEmptyString(record.executable, 'executable'),
    cwd: nonEmptyString(record.cwd, 'cwd'),
    ioMode,
    recoveryPolicy,
    shutdownPolicy,
    identity: {
      startedAt: nonEmptyString(identityValue.startedAt, 'identity.startedAt'),
      commandFingerprint: sha256Fingerprint(identityValue.commandFingerprint, 'identity.commandFingerprint'),
    },
    ...(logs === undefined ? {} : {logs}),
    createdAt: nonEmptyString(record.createdAt, 'createdAt'),
    metadata,
  };
}

function parseLogs(value: unknown): {stdoutPath: string; stderrPath: string} {
  const logs = objectValue(value, 'logs');
  return {
    stdoutPath: nonEmptyString(logs.stdoutPath, 'logs.stdoutPath'),
    stderrPath: nonEmptyString(logs.stderrPath, 'logs.stderrPath'),
  };
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
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

function sha256Fingerprint(value: unknown, label: string): string {
  const result = nonEmptyString(value, label);
  if (!/^[a-f0-9]{64}$/.test(result)) throw new Error(`${label} must be a lowercase SHA-256 fingerprint.`);
  return result;
}

function integer(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new Error(`${label} must be an integer.`);
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
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      assertJsonValue(item, `${label}.${key}`);
    }
    return;
  }
  throw new Error(`${label} contains a non-JSON value.`);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
