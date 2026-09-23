import type {ChildProcess} from 'node:child_process';
import {ProcessSupervisorError} from './errors.js';
import type {ProcessInspection, ProcessPlatform, ProcessScope} from './types.js';

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
  shouldStop: () => boolean = () => false,
): Promise<ProcessInspection | null> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const inspection = await platform.inspect(pid);
    if (inspection) return inspection;
    if (shouldStop() || Date.now() >= deadline) return null;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

export async function terminateKnownProcessScope(
  platform: ProcessPlatform,
  scope: ProcessScope,
  gracefulShutdownMs: number,
  forcedShutdownMs: number,
  pollMs: number,
): Promise<boolean> {
  if (!await platform.isScopeAlive(scope)) return false;
  await platform.terminateScope(scope, 'graceful');
  if (await waitForProcessScopeExit(platform, scope, gracefulShutdownMs, pollMs)) return false;

  await platform.terminateScope(scope, 'force');
  if (!await waitForProcessScopeExit(platform, scope, forcedShutdownMs, pollMs)) {
    throw new Error(`Process scope ${scope.kind}:${scope.id} did not exit after forced termination.`);
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

export function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0) throw new ProcessSupervisorError('INVALID_SPEC', `${label} must be a non-negative integer.`);
  return value;
}

export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForProcessScopeExit(
  platform: ProcessPlatform,
  scope: ProcessScope,
  timeoutMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (await platform.isScopeAlive(scope)) {
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  return true;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
