import {constants as fsConstants} from 'node:fs';
import {access, readFile} from 'node:fs/promises';
import {execFile, spawn as nodeSpawn} from 'node:child_process';
import type {
  ProcessInspection,
  ProcessPlatform,
  ProcessProbe,
  ProcessScope,
  ProcessSpawnRequest,
  ProcessTerminationMode,
} from '../types.js';
import {ProcessSupervisorError} from '../errors.js';

const PS_CANDIDATES = ['/bin/ps', '/usr/bin/ps'] as const;
const PS_OUTPUT_LIMIT = 1024 * 1024;
const POSIX_SCOPE_KIND = 'posix-process-group';
const LINUX_BOOT_ID_PATH = '/proc/sys/kernel/random/boot_id';

export class PosixProcessPlatform implements ProcessPlatform {
  private psExecutable: Promise<string> | null = null;
  private linuxBootId: Promise<string> | null = null;

  constructor() {
    if (process.platform === 'win32') {
      throw new ProcessSupervisorError(
        'UNSUPPORTED_PLATFORM',
        'The default process platform supports macOS and Linux only. Inject a platform implementation on other systems.',
      );
    }
  }

  spawn(request: ProcessSpawnRequest) {
    return nodeSpawn(request.executable, [...request.args], {
      cwd: request.cwd,
      detached: true,
      shell: false,
      stdio: request.stdio,
      env: request.env,
    });
  }

  async inspect(pid: number): Promise<ProcessInspection | null> {
    const before = await this.probe(pid);
    if (!before) return null;

    const ps = await this.resolvePsExecutable();
    let parsed: Omit<ProcessInspection, 'stableId'> | null;
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
      parsed = parseInspection(stdout, pid);
    } catch (error) {
      if (isMissingProcessError(error)) return null;
      throw error;
    }
    if (!parsed) return null;

    const after = await this.probe(pid);
    if (!after || before.stableId !== after.stableId || !scopeEquals(before.scope, after.scope)) return null;
    if (!scopeEquals(parsed.scope, after.scope)) {
      throw new Error(`Process inspection returned an inconsistent ownership scope for PID ${pid}.`);
    }

    return {...parsed, stableId: after.stableId};
  }

  async probeMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessProbe>> {
    const unique = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
    if (unique.length === 0) return new Map();

    if (process.platform === 'linux') {
      const probes = await Promise.all(unique.map(async (pid) => [pid, await this.probeLinux(pid)] as const));
      return new Map(probes.filter((entry): entry is readonly [number, ProcessProbe] => entry[1] !== null));
    }

    return this.probeDarwinMany(unique);
  }

  async isScopeAlive(scope: ProcessScope): Promise<boolean> {
    const processGroupId = processGroupIdOf(scope);
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

  async terminateScope(scope: ProcessScope, mode: ProcessTerminationMode): Promise<void> {
    const processGroupId = processGroupIdOf(scope);
    try {
      process.kill(-processGroupId, mode === 'graceful' ? 'SIGTERM' : 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }

  private async probe(pid: number): Promise<ProcessProbe | null> {
    if (process.platform === 'linux') return this.probeLinux(pid);
    return (await this.probeDarwinMany([pid])).get(pid) ?? null;
  }

  private async probeLinux(pid: number): Promise<ProcessProbe | null> {
    try {
      const [stat, bootId] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        this.resolveLinuxBootId(),
      ]);
      const parsed = parseLinuxStat(stat, pid);
      return {
        pid,
        scope: processGroupScope(parsed.processGroupId),
        stableId: `linux:${bootId}:${parsed.startTicks}`,
      };
    } catch (error) {
      if (isMissingLinuxProcess(error)) return null;
      throw error;
    }
  }

  private async probeDarwinMany(pids: readonly number[]): Promise<ReadonlyMap<number, ProcessProbe>> {
    const ps = await this.resolvePsExecutable();
    try {
      const stdout = await execute(ps, [
        '-ww',
        '-p',
        pids.join(','),
        '-o',
        'pid=',
        '-o',
        'pgid=',
        '-o',
        'lstart=',
      ]);
      return parseDarwinProbes(stdout);
    } catch (error) {
      if (isMissingProcessError(error)) return new Map();
      throw error;
    }
  }

  private resolvePsExecutable(): Promise<string> {
    this.psExecutable ??= findExecutable(PS_CANDIDATES, 'ps');
    return this.psExecutable;
  }

  private resolveLinuxBootId(): Promise<string> {
    this.linuxBootId ??= readFile(LINUX_BOOT_ID_PATH, 'utf8').then((value) => {
      const bootId = value.trim();
      if (!bootId) throw new Error('Linux boot identity is empty.');
      return bootId;
    });
    return this.linuxBootId;
  }
}

function parseInspection(output: string, requestedPid: number): Omit<ProcessInspection, 'stableId'> | null {
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

  return {pid, scope: processGroupScope(processGroupId), startedAt, commandLine};
}

function parseDarwinProbes(output: string): ReadonlyMap<number, ProcessProbe> {
  const probes = new Map<number, ProcessProbe>();
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const match = line.match(
      /^\s*(\d+)\s+(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s*$/,
    );
    if (!match) throw new Error(`Could not parse process liveness output: ${line}`);
    const pid = Number(match[1]);
    const processGroupId = Number(match[2]);
    const startedAt = new Date(match[3]!).toISOString();
    if (!Number.isInteger(pid) || pid <= 0 || !Number.isInteger(processGroupId) || processGroupId <= 0) {
      throw new Error(`Process liveness output contained an invalid PID or process group: ${line}`);
    }
    probes.set(pid, {
      pid,
      scope: processGroupScope(processGroupId),
      stableId: `darwin:${startedAt}`,
    });
  }
  return probes;
}

function parseLinuxStat(output: string, requestedPid: number): {processGroupId: number; startTicks: string} {
  const close = output.lastIndexOf(')');
  const open = output.indexOf('(');
  if (open < 0 || close <= open) throw new Error(`Could not parse /proc/${requestedPid}/stat.`);
  const pid = Number(output.slice(0, open).trim());
  if (pid !== requestedPid) throw new Error(`/proc stat returned unexpected PID ${pid}.`);

  const fields = output.slice(close + 1).trim().split(/\s+/);
  const processGroupId = Number(fields[2]);
  const startTicks = fields[19];
  if (!Number.isInteger(processGroupId) || processGroupId <= 0 || !startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error(`Could not parse stable process identity from /proc/${requestedPid}/stat.`);
  }
  return {processGroupId, startTicks};
}

function processGroupScope(processGroupId: number): ProcessScope {
  return {kind: POSIX_SCOPE_KIND, id: String(processGroupId)};
}

function processGroupIdOf(scope: ProcessScope): number {
  if (scope.kind !== POSIX_SCOPE_KIND || !/^\d+$/.test(scope.id)) {
    throw new ProcessSupervisorError('UNSUPPORTED_PLATFORM', `Unsupported process scope: ${scope.kind}:${scope.id}.`);
  }
  const value = Number(scope.id);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ProcessSupervisorError('UNSUPPORTED_PLATFORM', `Invalid POSIX process group scope: ${scope.id}.`);
  }
  return value;
}

function scopeEquals(left: ProcessScope, right: ProcessScope): boolean {
  return left.kind === right.kind && left.id === right.id;
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

function isMissingLinuxProcess(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
}

function isMissingProcessError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const code = (error as {code?: unknown}).code;
  return code === 1 || code === 'ESRCH';
}
