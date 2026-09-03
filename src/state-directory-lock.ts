import {mkdir, open, readFile, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {ProcessSupervisorError} from './errors.js';

const LOCK_FILE = '.process-supervisor.lock';
const MAX_STALE_RECOVERY_ATTEMPTS = 3;

interface LockRecord {
  pid: number;
  token: string;
  createdAt: string;
}

export class FileStateDirectoryLock {
  private readonly path: string;
  private readonly token = randomUUID();
  private acquired = false;

  constructor(private readonly stateDirectory: string) {
    this.path = join(stateDirectory, LOCK_FILE);
  }

  async acquire(): Promise<void> {
    if (this.acquired) return;
    await mkdir(this.stateDirectory, {recursive: true, mode: 0o700});

    for (let attempt = 0; attempt < MAX_STALE_RECOVERY_ATTEMPTS; attempt += 1) {
      try {
        const handle = await open(this.path, 'wx', 0o600);
        try {
          const record: LockRecord = {
            pid: process.pid,
            token: this.token,
            createdAt: new Date().toISOString(),
          };
          await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
        } finally {
          await handle.close();
        }
        this.acquired = true;
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code !== 'EEXIST') throw error;
      }

      const existing = await this.readExisting();
      if (existing && !isProcessAlive(existing.pid)) {
        await this.removeStale(existing.token);
        continue;
      }

      const owner = existing ? `PID ${existing.pid}` : 'an unreadable lock record';
      throw new ProcessSupervisorError(
        'STATE_DIRECTORY_LOCKED',
        `Process supervisor state directory is already owned by ${owner}: ${this.stateDirectory}`,
      );
    }

    throw new ProcessSupervisorError(
      'STATE_DIRECTORY_LOCKED',
      `Could not acquire process supervisor state directory after stale-lock recovery: ${this.stateDirectory}`,
    );
  }

  async release(): Promise<void> {
    if (!this.acquired) return;
    try {
      const existing = await this.readExisting();
      if (existing?.token === this.token) await rm(this.path, {force: true});
    } finally {
      this.acquired = false;
    }
  }

  private async readExisting(): Promise<LockRecord | null> {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object') return null;
      const value = parsed as Record<string, unknown>;
      if (!Number.isInteger(value.pid) || Number(value.pid) <= 0 || typeof value.token !== 'string') return null;
      return {
        pid: Number(value.pid),
        token: value.token,
        createdAt: typeof value.createdAt === 'string' ? value.createdAt : '',
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT') return null;
      return null;
    }
  }

  private async removeStale(expectedToken: string): Promise<void> {
    const current = await this.readExisting();
    if (!current || current.token !== expectedToken || isProcessAlive(current.pid)) return;
    await rm(this.path, {force: true});
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
