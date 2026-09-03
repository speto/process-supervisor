import {constants as fsConstants} from 'node:fs';
import {access} from 'node:fs/promises';
import {execFile} from 'node:child_process';
import type {ProcessInspection, ProcessPlatform} from '../types.js';
import {ProcessSupervisorError} from '../errors.js';

const PS_CANDIDATES = ['/bin/ps', '/usr/bin/ps'] as const;
const PS_OUTPUT_LIMIT = 1024 * 1024;

export class PosixProcessPlatform implements ProcessPlatform {
  private psExecutable: Promise<string> | null = null;

  constructor() {
    if (process.platform === 'win32') {
      throw new ProcessSupervisorError(
        'UNSUPPORTED_PLATFORM',
        'The default process platform supports macOS and Linux only.',
      );
    }
  }

  async inspect(pid: number): Promise<ProcessInspection | null> {
    const ps = await this.resolvePsExecutable();
    try {
      const stdout = await execute(ps, [
        '-ww',
        '-p',
        String(pid),
        '-o',
        'pid=',
        '-o',
        'pgid=',
        '-o',
        'lstart=',
        '-o',
        'command=',
      ]);
      return parseInspection(stdout, pid);
    } catch (error) {
      if (isMissingProcessError(error)) return null;
      throw error;
    }
  }

  async isProcessGroupAlive(processGroupId: number): Promise<boolean> {
    try {
      process.kill(-processGroupId, 0);
      return true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') return false;
      if (code === 'EPERM') return true;
      throw error;
    }
  }

  async signalProcessGroup(processGroupId: number, signal: NodeJS.Signals): Promise<void> {
    try {
      process.kill(-processGroupId, signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  private resolvePsExecutable(): Promise<string> {
    this.psExecutable ??= findExecutable(PS_CANDIDATES, 'ps');
    return this.psExecutable;
  }
}

function parseInspection(output: string, requestedPid: number): ProcessInspection | null {
  const line = output.trim();
  if (!line) return null;

  const match = line.match(
    /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/,
  );
  if (!match) throw new Error(`Could not parse process inspection output for PID ${requestedPid}.`);

  const pid = Number(match[1]);
  const processGroupId = Number(match[2]);
  const startedAt = new Date(match[3]!).toISOString();
  const commandLine = match[4]!.trim();

  if (!Number.isInteger(pid) || pid !== requestedPid) {
    throw new Error(`Process inspection returned unexpected PID ${String(match[1])}.`);
  }
  if (!Number.isInteger(processGroupId) || processGroupId <= 0) {
    throw new Error(`Process inspection returned invalid process group ${String(match[2])}.`);
  }
  if (!commandLine) throw new Error(`Process inspection returned an empty command line for PID ${pid}.`);

  return {pid, processGroupId, startedAt, commandLine};
}

function execute(executable: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        encoding: 'utf8',
        maxBuffer: PS_OUTPUT_LIMIT,
        env: {...process.env, LC_ALL: 'C', LANG: 'C'},
      },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function findExecutable(candidates: readonly string[], name: string): Promise<string> {
  for (const candidate of candidates) {
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Try the next well-known path.
    }
  }
  throw new Error(`Required process inspection executable '${name}' was not found.`);
}

function isMissingProcessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as {code?: unknown}).code;
  return code === 1 || code === 'ESRCH';
}
