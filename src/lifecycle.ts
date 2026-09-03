import type {ChildProcess} from 'node:child_process';
import {ProcessSupervisorError} from './errors.js';
import type {ProcessInspection, ProcessPlatform} from './types.js';

export function waitForSpawn(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    if (child.pid) {
      resolve(child.pid);
      return;
    }
    const onSpawn = () => {
      cleanup();
      if (!child.pid) reject(new Error('Managed process started without a PID.'));
      else resolve(child.pid);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      child.off('spawn', onSpawn);
      child.off('error', onError);
    };
    child.once('spawn', onSpawn);
    child.once('error', onError);
  });
}

export async function waitForInspection(
  platform: ProcessPlatform,
  pid: number,
  timeoutMs: number,
  pollMs: number,
): Promise<ProcessInspection | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspection = await platform.inspect(pid);
    if (inspection) return inspection;
    if (Date.now() >= deadline) return null;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

export async function terminateKnownProcessGroup(
  platform: ProcessPlatform,
  processGroupId: number,
  gracefulShutdownMs: number,
  forcedShutdownMs: number,
  groupPollMs: number,
): Promise<boolean> {
  if (!await platform.isProcessGroupAlive(processGroupId)) return false;
  await platform.signalProcessGroup(processGroupId, 'SIGTERM');
  if (await waitForProcessGroupExit(platform, processGroupId, gracefulShutdownMs, groupPollMs)) return false;

  await platform.signalProcessGroup(processGroupId, 'SIGKILL');
  if (!await waitForProcessGroupExit(platform, processGroupId, forcedShutdownMs, groupPollMs)) {
    throw new Error(`Process group ${processGroupId} did not exit after SIGKILL.`);
  }
  return true;
}

export function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new ProcessSupervisorError('INVALID_SPEC', `${label} must be a positive finite number.`);
  return value;
}

export function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new ProcessSupervisorError('INVALID_SPEC', `${label} must be a positive integer.`);
  return value;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForProcessGroupExit(
  platform: ProcessPlatform,
  processGroupId: number,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await platform.isProcessGroupAlive(processGroupId)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
