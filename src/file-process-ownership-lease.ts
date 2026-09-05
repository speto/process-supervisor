import {mkdir, readFile, rename, rm, writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ProcessSupervisorError} from './errors.js';
import {ensurePrivateDirectory} from './private-directory.js';
import type {ProcessOwnershipLease} from './types.js';

const LOCK_DIRECTORY = '.process-supervisor.lock';
const OWNER_FILE = 'owner.json';
const MAX_STALE_RECOVERY_ATTEMPTS = 8;

interface LeaseRecord {
  pid: number;
  token: string;
  createdAt: string;
}

export class FileProcessOwnershipLease implements ProcessOwnershipLease {
  private readonly path: string;
  private readonly token = randomUUID();
  private acquired = false;

  constructor(private readonly stateDirectory: string) {
    this.path = join(stateDirectory, LOCK_DIRECTORY);
  }

  async acquire(): Promise<void> {
    if (this.acquired) return;
    await ensurePrivateDirectory(this.stateDirectory, 'Process supervisor state directory');

    for (let attempt = 0; attempt < MAX_STALE_RECOVERY_ATTEMPTS; attempt += 1) {
      const candidate = this.candidatePath();
      await this.prepareCandidate(candidate);
      try {
        await rename(candidate, this.path);
        this.acquired = true;
        return;
      } catch (error) {
        await rm(candidate, {recursive: true, force: true}).catch(() => undefined);
        if (!isDestinationExists(error)) throw error;
      }

      const existing = await this.readExisting();
      if (!existing) {
        throw new ProcessSupervisorError(
          'STATE_DIRECTORY_LOCKED',
          `Process supervisor state directory contains an unreadable ownership lease: ${this.stateDirectory}`,
        );
      }
      if (isProcessAlive(existing.pid)) {
        throw new ProcessSupervisorError(
          'STATE_DIRECTORY_LOCKED',
          `Process supervisor state directory is already owned by PID ${existing.pid}: ${this.stateDirectory}`,
        );
      }

      const quarantine = this.quarantinePath('stale');
      try {
        await rename(this.path, quarantine);
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      await rm(quarantine, {recursive: true, force: true}).catch(() => undefined);
    }

    throw new ProcessSupervisorError(
      'STATE_DIRECTORY_LOCKED',
      `Could not acquire process supervisor state directory after stale-lease recovery: ${this.stateDirectory}`,
    );
  }

  async release(): Promise<void> {
    if (!this.acquired) return;

    const existing = await this.readExisting();
    if (!existing || existing.token !== this.token) {
      this.acquired = false;
      return;
    }

    const quarantine = this.quarantinePath('release');
    try {
      await rename(this.path, quarantine);
    } catch (error) {
      if (isMissing(error)) {
        this.acquired = false;
        return;
      }
      throw error;
    }

    this.acquired = false;
    await rm(quarantine, {recursive: true, force: true}).catch(() => undefined);
  }

  private async prepareCandidate(candidate: string): Promise<void> {
    await mkdir(candidate, {mode: 0o700});
    try {
      const record: LeaseRecord = {
        pid: process.pid,
        token: this.token,
        createdAt: new Date().toISOString(),
      };
      await writeFile(
        join(candidate, OWNER_FILE),
        `${JSON.stringify(record)}\n`,
        {encoding: 'utf8', mode: 0o600, flag: 'wx', flush: true},
      );
    } catch (error) {
      await rm(candidate, {recursive: true, force: true}).catch(() => undefined);
      throw error;
    }
  }

  private async readExisting(): Promise<LeaseRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.path, OWNER_FILE), 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const value = parsed as Record<string, unknown>;
      if (!Number.isInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string' || value.token.length === 0) {
        return null;
      }
      return {
        pid: Number(value.pid),
        token: value.token,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
      };
    } catch {
      return null;
    }
  }

  private candidatePath(): string {
    return join(this.stateDirectory, `${LOCK_DIRECTORY}.candidate-${process.pid}-${this.token}-${randomUUID()}`);
  }

  private quarantinePath(kind: 'stale' | 'release'): string {
    return join(this.stateDirectory, `${LOCK_DIRECTORY}.${kind}-${process.pid}-${this.token}-${randomUUID()}`);
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    return true;
  }
}

function isDestinationExists(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EEXIST' || code === 'ENOTEMPTY';
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}
