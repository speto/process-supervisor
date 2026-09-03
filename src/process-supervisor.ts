import {type ChildProcess} from 'node:child_process';
import {isAbsolute} from 'node:path';
import {ProcessSupervisorError} from './errors.js';
import {
  messageOf,
  positiveFinite,
  positiveInteger,
  terminateKnownProcessScope,
} from './lifecycle.js';
import {OwnershipCoordinator} from './ownership-coordinator.js';
import {PosixProcessPlatform} from './platform/posix-process-platform.js';
import {
  cloneSnapshot,
  emptySnapshot,
  identityMatches,
  normalizeSpec,
  snapshotFromRecord,
  startingSnapshot,
  validateSpec,
  type NormalizedProcessSpec,
} from './process-spec.js';
import {
  adoptProcess,
  launchProcess,
  ProcessLaunchFailure,
  pruneDurableLogs,
  readDurableOutputTail,
  releaseRuntime,
  type ProcessRuntimeContext,
  type RuntimeProcess,
} from './process-runtime.js';
import {reconcileProcessRecords} from './reconciliation.js';
import {FileProcessRecordStore} from './record-store.js';
import {FileStateDirectoryLock} from './state-directory-lock.js';
import type {
  DurableProcessRecord,
  ManagedProcessOutputEvent,
  ManagedProcessOutputStream,
  ManagedProcessSnapshot,
  ManagedProcessSpec,
  ManagedProcessStateEvent,
  ManagedProcessTransport,
  ProcessPlatform,
  ProcessRecordStore,
  ProcessSupervisorOptions,
  ReconciliationResult,
} from './types.js';

const DEFAULT_GRACEFUL_SHUTDOWN_MS = 5_000;
const DEFAULT_FORCED_SHUTDOWN_MS = 2_000;
const DEFAULT_GROUP_POLL_MS = 25;
const DEFAULT_MONITOR_POLL_MS = 2_000;
const DEFAULT_LOG_POLL_MS = 250;
const DEFAULT_RETAINED_LOG_LAUNCHES = 3;
const DEFAULT_RETAINED_SNAPSHOTS = 256;

export class ProcessSupervisor {
  private readonly recordStore: ProcessRecordStore;
  private readonly platform: ProcessPlatform;
  private readonly gracefulShutdownMs: number;
  private readonly forcedShutdownMs: number;
  private readonly groupPollMs: number;
  private readonly monitorPollMs: number;
  private readonly logPollMs: number;
  private readonly maxRetainedLogLaunches: number;
  private readonly maxRetainedSnapshots: number;
  private readonly now: () => Date;
  private readonly onState: (event: ManagedProcessStateEvent) => void;
  private readonly onOutput: (event: ManagedProcessOutputEvent) => void;
  private readonly runtimes = new Map<string, RuntimeProcess>();
  private readonly snapshots = new Map<string, ManagedProcessSnapshot>();
  private readonly coordinator = new OwnershipCoordinator();
  private readonly stateLock: FileStateDirectoryLock | null;
  private stateOwnership: Promise<void> | null = null;
  private monitorTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(private readonly options: ProcessSupervisorOptions) {
    if (!isAbsolute(options.stateDirectory)) {
      throw new ProcessSupervisorError('INVALID_SPEC', 'Process supervisor state directory must be an absolute path.');
    }
    this.recordStore = options.recordStore ?? new FileProcessRecordStore(options.stateDirectory);
    this.platform = options.platform ?? new PosixProcessPlatform();
    this.stateLock = this.recordStore instanceof FileProcessRecordStore
      ? new FileStateDirectoryLock(this.recordStore.stateDirectory)
      : null;
    this.gracefulShutdownMs = positiveFinite(options.gracefulShutdownMs ?? DEFAULT_GRACEFUL_SHUTDOWN_MS, 'Graceful shutdown timeout');
    this.forcedShutdownMs = positiveFinite(options.forcedShutdownMs ?? DEFAULT_FORCED_SHUTDOWN_MS, 'Forced shutdown timeout');
    this.groupPollMs = positiveFinite(options.groupPollMs ?? DEFAULT_GROUP_POLL_MS, 'Process scope poll interval');
    this.monitorPollMs = positiveFinite(options.monitorPollMs ?? DEFAULT_MONITOR_POLL_MS, 'Process monitor poll interval');
    this.logPollMs = positiveFinite(options.logPollMs ?? DEFAULT_LOG_POLL_MS, 'Log poll interval');
    this.maxRetainedLogLaunches = positiveInteger(options.maxRetainedLogLaunches ?? DEFAULT_RETAINED_LOG_LAUNCHES, 'Retained log launch limit');
    this.maxRetainedSnapshots = positiveInteger(options.maxRetainedSnapshots ?? DEFAULT_RETAINED_SNAPSHOTS, 'Retained snapshot limit');
    this.now = options.now ?? (() => new Date());
    this.onState = options.onState ?? (() => {});
    this.onOutput = options.onOutput ?? (() => {});
  }

  getSnapshot(processId: string): ManagedProcessSnapshot | null {
    const snapshot = this.snapshots.get(processId);
    return snapshot ? cloneSnapshot(snapshot) : null;
  }

  listSnapshots(): readonly ManagedProcessSnapshot[] {
    return [...this.snapshots.values()].map(cloneSnapshot);
  }

  forget(processId: string): boolean {
    if (this.runtimes.has(processId)) {
      throw new ProcessSupervisorError('PROCESS_ALREADY_MANAGED', `Cannot forget process ${processId} while ownership is active.`);
    }
    return this.snapshots.delete(processId);
  }

  getTransport(processId: string): ManagedProcessTransport {
    this.assertOpen();
    const runtime = this.runtimes.get(processId);
    if (!runtime?.transport) {
      throw new ProcessSupervisorError('PROCESS_NOT_FOUND', `Process ${processId} does not expose raw pipe transport.`);
    }
    return runtime.transport;
  }

  start(spec: ManagedProcessSpec): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    const normalized = normalizeSpec(spec);
    return this.runOwned(() => this.startLocked(normalized));
  }

  restart(spec: ManagedProcessSpec): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    const normalized = normalizeSpec(spec);
    return this.runOwned(async () => {
      if (this.runtimes.has(normalized.id)) await this.stopLocked(normalized.id);
      return this.startLocked(normalized);
    });
  }

  stop(processId: string): Promise<ManagedProcessSnapshot> {
    this.assertOpen();
    return this.runOwned(() => this.stopLocked(processId));
  }

  reconcile(): Promise<ReconciliationResult> {
    this.assertOpen();
    return this.runOwned(() => reconcileProcessRecords({
      recordStore: this.recordStore,
      platform: this.platform,
      isAlreadyManaged: (processId) => this.runtimes.has(processId),
      terminate: (record) => this.terminateVerifiedRecord(record),
      adopt: async (record) => {
        const runtime = await adoptProcess(record, this.runtimeContext());
        this.runtimes.set(record.id, runtime);
        this.publish(snapshotFromRecord(record, 'running', 'adopted', null));
        this.scheduleMonitor();
      },
      onRecordRemoved: (record) => this.pruneRecordLogs(record),
      publish: (snapshot) => this.publish(snapshot),
    }));
  }

  async readOutputTail(
    processId: string,
    stream: ManagedProcessOutputStream,
    maxBytes = 64 * 1024,
  ): Promise<string> {
    const runtime = this.runtimes.get(processId);
    if (!runtime?.record.logs) {
      throw new ProcessSupervisorError('PROCESS_NOT_FOUND', `Process ${processId} has no durable output.`);
    }
    return readDurableOutputTail(runtime, stream, maxBytes);
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    return this.coordinator.close(() => this.closeLocked());
  }

  private async closeLocked(): Promise<void> {
    if (this.closed) return;
    this.clearMonitor();

    const errors: unknown[] = [];
    for (const processId of [...this.runtimes.keys()]) {
      const runtime = this.runtimes.get(processId);
      if (!runtime) continue;
      if (runtime.record.shutdownPolicy === 'preserve') {
        releaseRuntime(runtime);
        this.runtimes.delete(processId);
        continue;
      }
      try {
        await this.stopLocked(processId);
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      this.scheduleMonitor();
      throw new ProcessSupervisorError(
        'PROCESS_STOP_FAILED',
        `Failed to stop ${errors.length} managed process${errors.length === 1 ? '' : 'es'} during close. Ownership was retained for retry.`,
        {cause: new AggregateError(errors)},
      );
    }

    await this.releaseStateOwnership();
    this.closed = true;
  }

  private async startLocked(spec: NormalizedProcessSpec): Promise<ManagedProcessSnapshot> {
    if (this.runtimes.has(spec.id)) {
      throw new ProcessSupervisorError('PROCESS_ALREADY_MANAGED', `Process ${spec.id} is already managed.`);
    }

    const persisted = await this.recordStore.get(spec.id);
    if (persisted?.kind === 'valid') {
      throw new ProcessSupervisorError(
        'PROCESS_ALREADY_MANAGED',
        `Process ${spec.id} already has durable ownership state. Reconcile it before starting a replacement.`,
      );
    }
    if (persisted?.kind === 'invalid') {
      throw new ProcessSupervisorError(
        'STATE_STORE_FAILED',
        `Process ${spec.id} has an invalid durable ownership record: ${persisted.error}`,
      );
    }

    await validateSpec(spec);
    this.publish(startingSnapshot(spec));
    try {
      const runtime = await launchProcess(
        spec,
        this.runtimeContext(),
        (child, code, signal) => {
          void this.coordinator.runInternal(() => this.handleChildExitLocked(spec.id, child, code, signal));
        },
      );
      this.runtimes.set(spec.id, runtime);
      this.publish(snapshotFromRecord(runtime.record, 'running', 'started', null));
      return this.getSnapshot(spec.id)!;
    } catch (error) {
      if (error instanceof ProcessLaunchFailure && error.residualRuntime) {
        const runtime = error.residualRuntime;
        this.runtimes.set(spec.id, runtime);
        this.publish({
          ...snapshotFromRecord(runtime.record, 'unresolved', 'started', null),
          error: `Launch failed and residual cleanup failed. Ownership was retained${error.recordPersisted ? '' : ' in memory only'}: ${messageOf(error.cleanupError)}`,
        });
        throw new ProcessSupervisorError(
          'PROCESS_START_FAILED',
          `Failed to start process ${spec.id}; residual ownership is retained for explicit cleanup.`,
          {cause: error},
        );
      }

      this.publish({
        ...startingSnapshot(spec),
        state: error instanceof ProcessLaunchFailure ? 'unresolved' : 'crashed',
        error: error instanceof ProcessLaunchFailure
          ? `Failed to start managed process and cleanup could not be proven: ${messageOf(error.cleanupError)}`
          : `Failed to start managed process: ${messageOf(error)}`,
      });
      throw new ProcessSupervisorError(
        'PROCESS_START_FAILED',
        `Failed to start process ${spec.id}: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  private async stopLocked(processId: string): Promise<ManagedProcessSnapshot> {
    const runtime = this.runtimes.get(processId);
    if (!runtime) {
      const existing = this.snapshots.get(processId);
      if (existing?.state === 'stopped') return cloneSnapshot(existing);
      throw new ProcessSupervisorError('PROCESS_NOT_FOUND', `Process ${processId} is not managed.`);
    }

    const current = this.snapshotFor(runtime);
    if (
      runtime.child
      && current.state !== 'unresolved'
      && (runtime.child.exitCode !== null || runtime.child.signalCode !== null)
    ) {
      return this.handleChildExitLocked(
        processId,
        runtime.child,
        runtime.child.exitCode,
        runtime.child.signalCode,
      );
    }

    runtime.expectedStop = true;
    this.publish({...current, state: 'stopping', error: null, forcedTermination: false});

    try {
      let forced = false;
      if (runtime.child && runtime.child.exitCode === null && runtime.child.signalCode === null) {
        forced = await terminateKnownProcessScope(
          this.platform,
          runtime.record.scope,
          this.gracefulShutdownMs,
          this.forcedShutdownMs,
          this.groupPollMs,
        );
      } else {
        const probes = await this.platform.probeMany([runtime.record.pid]);
        const probe = probes.get(runtime.record.pid);
        if (probe && !identityMatches(runtime.record, probe)) {
          await this.discardUnsafeIdentity(runtime, 'Live PID no longer matches the recorded stable process identity.');
          throw new ProcessSupervisorError(
            'PROCESS_IDENTITY_MISMATCH',
            `Process ${processId} no longer matches its recorded identity.`,
          );
        }
        forced = await terminateKnownProcessScope(
          this.platform,
          runtime.record.scope,
          this.gracefulShutdownMs,
          this.forcedShutdownMs,
          this.groupPollMs,
        );
      }

      await this.recordStore.remove(processId);
      releaseRuntime(runtime);
      this.runtimes.delete(processId);
      await this.pruneRecordLogs(runtime.record);
      const previous = this.snapshots.get(processId);
      const stopped: ManagedProcessSnapshot = {
        ...snapshotFromRecord(runtime.record, 'stopped', null, null),
        lastExitCode: previous?.lastExitCode ?? null,
        lastSignal: previous?.lastSignal ?? null,
        forcedTermination: forced,
      };
      this.publish(stopped);
      return cloneSnapshot(stopped);
    } catch (error) {
      runtime.expectedStop = false;
      if (error instanceof ProcessSupervisorError && error.code === 'PROCESS_IDENTITY_MISMATCH') throw error;
      if (this.runtimes.get(processId) === runtime) {
        this.publish({
          ...snapshotFromRecord(runtime.record, 'unresolved', runtime.child ? 'started' : 'adopted', null),
          lastExitCode: current.lastExitCode,
          lastSignal: current.lastSignal,
          error: `Failed to stop managed process; ownership was retained for retry: ${messageOf(error)}`,
        });
      }
      throw new ProcessSupervisorError(
        'PROCESS_STOP_FAILED',
        `Failed to stop process ${processId}: ${messageOf(error)}`,
        {cause: error},
      );
    }
  }

  private async handleChildExitLocked(
    processId: string,
    child: ChildProcess,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): Promise<ManagedProcessSnapshot> {
    const runtime = this.runtimes.get(processId);
    if (!runtime || runtime.child !== child) {
      return this.getSnapshot(processId) ?? emptySnapshot(processId);
    }

    const current = this.snapshotFor(runtime);
    if (runtime.expectedStop || current.state === 'stopping') return current;

    const detail = code !== null ? ` with code ${code}` : signal ? ` from ${signal}` : '';
    try {
      await terminateKnownProcessScope(
        this.platform,
        runtime.record.scope,
        this.gracefulShutdownMs,
        this.forcedShutdownMs,
        this.groupPollMs,
      );
    } catch (error) {
      const unresolved = {
        ...snapshotFromRecord(runtime.record, 'unresolved', 'started', null),
        lastExitCode: code,
        lastSignal: signal,
        error: `Managed process exited unexpectedly${detail}; residual scope cleanup failed and ownership was retained: ${messageOf(error)}`,
      };
      this.publish(unresolved);
      return cloneSnapshot(unresolved);
    }

    try {
      await this.recordStore.remove(processId);
    } catch (error) {
      const unresolved = {
        ...snapshotFromRecord(runtime.record, 'unresolved', 'started', null),
        lastExitCode: code,
        lastSignal: signal,
        error: `Managed process exited unexpectedly${detail}; cleanup succeeded but durable ownership could not be cleared: ${messageOf(error)}`,
      };
      this.publish(unresolved);
      return cloneSnapshot(unresolved);
    }

    releaseRuntime(runtime);
    this.runtimes.delete(processId);
    await this.pruneRecordLogs(runtime.record);
    const crashed = {
      ...this.snapshotForRecordWithExit(runtime.record, code, signal),
      error: `Managed process exited unexpectedly${detail}.`,
    };
    this.publish(crashed);
    return cloneSnapshot(crashed);
  }

  private scheduleMonitor(): void {
    if (this.monitorTimer || this.closed || !this.hasAdoptedRuntimes()) return;
    this.monitorTimer = setTimeout(() => {
      this.monitorTimer = null;
      void this.coordinator.runInternal(() => this.monitorAdoptedBatchLocked());
    }, this.monitorPollMs);
    this.monitorTimer.unref();
  }

  private clearMonitor(): void {
    if (this.monitorTimer) clearTimeout(this.monitorTimer);
    this.monitorTimer = null;
  }

  private async monitorAdoptedBatchLocked(): Promise<void> {
    if (this.closed) return;
    const runtimes = [...this.runtimes.values()].filter((runtime) => runtime.child === null);
    if (runtimes.length === 0) return;

    let probes;
    try {
      probes = await this.platform.probeMany(runtimes.map((runtime) => runtime.record.pid));
    } catch (error) {
      for (const runtime of runtimes) {
        if (this.runtimes.get(runtime.record.id) !== runtime) continue;
        this.publish({
          ...snapshotFromRecord(runtime.record, 'unresolved', 'adopted', null),
          error: `Process inspection failed; ownership was retained: ${messageOf(error)}`,
        });
      }
      this.scheduleMonitor();
      return;
    }

    for (const runtime of runtimes) {
      if (this.runtimes.get(runtime.record.id) !== runtime) continue;
      const probe = probes.get(runtime.record.pid);
      if (!probe) {
        await this.handleAdoptedExitLocked(runtime);
        continue;
      }

      if (!identityMatches(runtime.record, probe)) {
        try {
          await this.discardUnsafeIdentity(runtime, 'Adopted PID now belongs to a different stable process identity.');
        } catch (error) {
          this.publish({
            ...snapshotFromRecord(runtime.record, 'unresolved', 'adopted', null),
            error: `Process identity became unsafe and durable ownership cleanup failed: ${messageOf(error)}`,
          });
        }
        continue;
      }

      const snapshot = this.snapshots.get(runtime.record.id);
      if (snapshot?.state !== 'running' || snapshot.error) {
        this.publish(snapshotFromRecord(runtime.record, 'running', 'adopted', null));
      }
    }

    this.scheduleMonitor();
  }

  private async handleAdoptedExitLocked(runtime: RuntimeProcess): Promise<void> {
    try {
      await terminateKnownProcessScope(
        this.platform,
        runtime.record.scope,
        this.gracefulShutdownMs,
        this.forcedShutdownMs,
        this.groupPollMs,
      );
      await this.recordStore.remove(runtime.record.id);
    } catch (error) {
      this.publish({
        ...snapshotFromRecord(runtime.record, 'unresolved', 'adopted', null),
        error: `Adopted process exited, but residual cleanup could not be proven. Ownership was retained: ${messageOf(error)}`,
      });
      return;
    }

    releaseRuntime(runtime);
    this.runtimes.delete(runtime.record.id);
    await this.pruneRecordLogs(runtime.record);
    this.publish({
      ...snapshotFromRecord(runtime.record, 'crashed', null, null),
      error: 'Adopted process exited after recovery.',
    });
  }

  private async discardUnsafeIdentity(runtime: RuntimeProcess, reason: string): Promise<void> {
    let removalError: unknown | null = null;
    try {
      await this.recordStore.remove(runtime.record.id);
    } catch (error) {
      removalError = error;
    }

    releaseRuntime(runtime);
    this.runtimes.delete(runtime.record.id);
    if (!removalError) await this.pruneRecordLogs(runtime.record);
    this.publish({
      ...snapshotFromRecord(runtime.record, 'unresolved', null, null),
      pid: null,
      scope: null,
      startedAt: null,
      error: removalError ? `${reason} ${messageOf(removalError)}` : reason,
    });
    if (removalError) throw removalError;
  }

  private async terminateVerifiedRecord(record: DurableProcessRecord): Promise<void> {
    const probes = await this.platform.probeMany([record.pid]);
    const probe = probes.get(record.pid);
    if (probe && !identityMatches(record, probe)) {
      throw new ProcessSupervisorError(
        'PROCESS_IDENTITY_MISMATCH',
        `Process ${record.id} no longer matches its recorded identity.`,
      );
    }
    await terminateKnownProcessScope(
      this.platform,
      record.scope,
      this.gracefulShutdownMs,
      this.forcedShutdownMs,
      this.groupPollMs,
    );
  }

  private runtimeContext(): ProcessRuntimeContext {
    return {
      stateDirectory: this.options.stateDirectory,
      recordStore: this.recordStore,
      platform: this.platform,
      gracefulShutdownMs: this.gracefulShutdownMs,
      forcedShutdownMs: this.forcedShutdownMs,
      groupPollMs: this.groupPollMs,
      logPollMs: this.logPollMs,
      maxRetainedLogLaunches: this.maxRetainedLogLaunches,
      now: this.now,
      onOutput: this.onOutput,
    };
  }

  private snapshotFor(runtime: RuntimeProcess): ManagedProcessSnapshot {
    return this.getSnapshot(runtime.record.id)
      ?? snapshotFromRecord(runtime.record, 'running', runtime.child ? 'started' : 'adopted', null);
  }

  private snapshotForRecordWithExit(
    record: DurableProcessRecord,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): ManagedProcessSnapshot {
    return {
      ...snapshotFromRecord(record, 'crashed', null, null),
      lastExitCode: code,
      lastSignal: signal,
    };
  }

  private publish(snapshot: ManagedProcessSnapshot): void {
    const copy = cloneSnapshot(snapshot);
    this.snapshots.delete(snapshot.id);
    this.snapshots.set(snapshot.id, copy);
    this.evictSnapshots();
    try {
      this.onState({processId: snapshot.id, snapshot: cloneSnapshot(copy)});
    } catch {
      // Observers must not destabilize process supervision.
    }
  }

  private evictSnapshots(): void {
    while (this.snapshots.size > this.maxRetainedSnapshots) {
      const candidate = [...this.snapshots.entries()].find(([processId, snapshot]) => {
        if (this.runtimes.has(processId)) return false;
        return snapshot.state !== 'starting' && snapshot.state !== 'running' && snapshot.state !== 'stopping';
      });
      if (!candidate) return;
      this.snapshots.delete(candidate[0]);
    }
  }

  private async pruneRecordLogs(record: DurableProcessRecord): Promise<void> {
    if (!record.logs) return;
    await pruneDurableLogs(this.options.stateDirectory, record.id, this.maxRetainedLogLaunches).catch(() => undefined);
  }

  private hasAdoptedRuntimes(): boolean {
    return [...this.runtimes.values()].some((runtime) => runtime.child === null);
  }

  private runOwned<T>(operation: () => Promise<T>): Promise<T> {
    return this.coordinator.run(async () => {
      await this.ensureStateOwnership();
      return operation();
    });
  }

  private async ensureStateOwnership(): Promise<void> {
    if (!this.stateLock) return;
    this.stateOwnership ??= this.stateLock.acquire().catch((error) => {
      this.stateOwnership = null;
      throw error;
    });
    await this.stateOwnership;
  }

  private async releaseStateOwnership(): Promise<void> {
    if (!this.stateLock || !this.stateOwnership) return;
    await this.stateOwnership;
    await this.stateLock.release();
    this.stateOwnership = null;
  }

  private assertOpen(): void {
    if (this.closed || !this.coordinator.isAccepting) {
      throw new ProcessSupervisorError('PROCESS_STOP_FAILED', 'Process supervisor is closed or closing.');
    }
  }
}
